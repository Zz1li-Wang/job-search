import { ProbeErrorCode } from "./error-codes.ts";
import { extname, join } from "node:path";
import {
  ProbeInputSchema,
  type ProbeInput,
  type ProbeReport,
  type DocumentProbeResult,
} from "./dto.ts";
import { ProbeError } from "./domain.ts";
import { createFixtures } from "./fixtures.ts";
import { extractDocument } from "./documents.ts";
import { probeModel } from "./model-probe.ts";
import type { ModelFetch } from "./deepseek.ts";
import { SourceAdapter, type SourceFetch } from "./source.ts";
import { ReportStore } from "./report-store.ts";

export async function probeDocuments(
  directory: string,
): Promise<DocumentProbeResult> {
  const fixtures = await createFixtures(join(directory, "fixtures"));
  const results: DocumentProbeResult["fixtures"] = [];
  for (const fixture of fixtures) {
    try {
      const spans = await extractDocument(fixture.path);
      const expectedTextFound = spans.some((span) =>
        span.text.includes("Test Student"),
      );
      results.push({
        fixtureId: fixture.id,
        format: extname(fixture.path),
        status:
          fixture.expected === "readable" && expectedTextFound
            ? "passed"
            : "failed",
        expected: fixture.expected,
        spans,
      });
    } catch (error) {
      const code =
        error instanceof ProbeError
          ? error.code
          : ProbeErrorCode.UnexpectedExtractionFailure;
      results.push({
        fixtureId: fixture.id,
        format: extname(fixture.path),
        status:
          fixture.expected === "rejected" && fixture.expectedCode === code
            ? "passed"
            : "failed",
        expected: fixture.expected,
        spans: [],
        errorCode: code,
      });
    }
  }
  return {
    status: results.every((fixture) => fixture.status === "passed")
      ? "passed"
      : "failed",
    summary:
      "文档结果逐项记录；负例passed表示正确拒绝，不表示扫描件或加密文件可读取。",
    fixtures: results,
    evidenceFiles: fixtures.map(
      (fixture) => `fixtures/${fixture.path.split("/").at(-1)}`,
    ),
    limitations: [
      "简历均为虚构测试数据，不使用OCR或模型识别字段。",
      "PDF样本为英文嵌入文本；DOCX/TXT包含中文。未验证中文字体复杂PDF、真实多栏简历和生产环境负载。",
      "图像PDF用于模拟无文字层输入；其内容不是经过OCR识别的简历。",
    ],
  };
}

/** 用例只编排状态与适配器，不承担源站解析或文件持久化细节。 */
export class VerificationService {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly sourceFetch?: SourceFetch;
  private readonly modelFetch?: ModelFetch;
  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    sourceFetch?: SourceFetch,
    modelFetch?: ModelFetch,
  ) {
    this.environment = environment;
    this.sourceFetch = sourceFetch;
    this.modelFetch = modelFetch;
  }
  async run(input: ProbeInput): Promise<ProbeReport> {
    const request = ProbeInputSchema.parse(input);
    const store = new ReportStore(request.outputRoot, request.runId);
    const previous = await store.load();
    if (previous) {
      if (
        previous.kind !== request.kind ||
        previous.requestLimit !== request.requestLimit
      )
        throw new ProbeError(ProbeErrorCode.ProbeRunPayloadConflict);
      return previous;
    }
    await store.acquire();
    let isReportComplete = false;
    try {
      // 锁内复查，避免另一个进程刚完成时再次执行收费请求。
      const completed = await store.load();
      if (completed) {
        if (
          completed.kind !== request.kind ||
          completed.requestLimit !== request.requestLimit
        )
          throw new ProbeError(ProbeErrorCode.ProbeRunPayloadConflict);
        isReportComplete = true;
        return completed;
      }
      const report: ProbeReport = {
        runId: request.runId,
        kind: request.kind,
        requestLimit: request.requestLimit,
        startedAt: new Date().toISOString(),
        endedAt: "",
        overall: "blocked",
      };
      if (request.kind === "source" || request.kind === "all")
        report.source = await new SourceAdapter(
          store.directory,
          request.requestLimit,
          this.sourceFetch,
        ).probe();
      if (request.kind === "document" || request.kind === "all")
        report.document = await probeDocuments(store.directory);
      if (request.kind === "model" || request.kind === "all")
        report.model = await probeModel(
          store.directory,
          request.outputRoot,
          request.runId,
          this.environment,
          this.modelFetch,
        );
      const capabilities = [
        report.source,
        report.document,
        report.model,
      ].filter((entry) => entry !== undefined);
      report.overall = capabilities.every((entry) => entry.status === "passed")
        ? "passed"
        : capabilities.some((entry) => entry.status === "failed")
          ? "failed"
          : "blocked";
      report.endedAt = new Date().toISOString();
      await store.save(report);
      isReportComplete = true;
      return report;
    } finally {
      // 保存失败时保留中断锁，后续同runId不能悄悄重做未知外部副作用。
      if (isReportComplete) await store.release();
    }
  }
}
