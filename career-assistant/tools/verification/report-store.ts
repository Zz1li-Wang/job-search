import { ProbeErrorCode } from "./error-codes.ts";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
  readdir,
} from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { ProbeError } from "./domain.ts";
import {
  ProbeReportSchema,
  type ProbeReport,
  type CapabilityResult,
} from "./dto.ts";

/** 文件持久化适配器，不含能力决策；进程中断留下锁，禁止盲目接管收费调用。 */
export class ReportStore {
  readonly directory: string;
  constructor(root: string, runId: string) {
    this.directory = resolve(root, runId);
  }
  async load(): Promise<ProbeReport | undefined> {
    try {
      return ProbeReportSchema.parse(
        JSON.parse(await readFile(join(this.directory, "report.json"), "utf8")),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw new ProbeError(ProbeErrorCode.InvalidSavedReport);
    }
  }
  async acquire(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    try {
      const handle = await open(join(this.directory, ".running"), "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
    } catch {
      throw new ProbeError(ProbeErrorCode.ProbeRunConflict);
    }
  }
  async release(): Promise<void> {
    await unlink(join(this.directory, ".running"));
  }
  async save(report: ProbeReport): Promise<void> {
    ProbeReportSchema.parse(report);
    const rows: [string, CapabilityResult][] = [];
    if (report.source) rows.push(["来源", report.source]);
    if (report.document) rows.push(["文档", report.document]);
    if (report.model) rows.push(["模型", report.model]);
    const markdown = [
      "# 第三步能力验证报告",
      "",
      `运行ID：${report.runId}；总状态：${report.overall}。`,
      `起止：${report.startedAt} — ${report.endedAt}。`,
      "",
      ...rows.flatMap(([name, capability]) => [
        `## ${name}：${capability.status}`,
        "",
        capability.summary,
        "",
        ...capability.limitations.map((line) => `- ${line}`),
        "",
      ]),
      "本报告只验证明确列出的样本；不代表业务模块实现、全站覆盖或步骤已获用户验收。",
      "",
    ].join("\n");
    await this.atomic("report.md", markdown);
    const manifest: { file: string; sha256: string }[] = [];
    const scan = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await scan(path);
        else if (
          !entry.name.startsWith(".") &&
          !["manifest.json", "report.json"].includes(entry.name)
        )
          manifest.push({
            file: relative(this.directory, path),
            sha256: createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
          });
      }
    };
    await scan(this.directory);
    await this.atomic(
      "manifest.json",
      JSON.stringify({ runId: report.runId, artifacts: manifest }, null, 2) +
        "\n",
    );
    // report.json最后原子发布，作为本次执行已形成完整报告的标记；不代表各能力都通过。
    await this.atomic("report.json", JSON.stringify(report, null, 2) + "\n");
  }
  private async atomic(name: string, content: string): Promise<void> {
    await writeFile(join(this.directory, `.${name}.tmp`), content);
    await rename(
      join(this.directory, `.${name}.tmp`),
      join(this.directory, name),
    );
  }
}
