import { parseArgs } from "node:util";
import { ProbeInputSchema } from "./dto.ts";
import { VerificationService } from "./service.ts";

/** 独立命令只解析DTO并调用Service；不得把配置值打印到终端。 */
try {
  const { values } = parseArgs({
    options: {
      kind: { type: "string" },
      "run-id": { type: "string" },
      output: { type: "string" },
      limit: { type: "string", default: "20" },
    },
  });
  const input = ProbeInputSchema.parse({
    kind: values.kind,
    runId: values["run-id"],
    outputRoot: values.output,
    requestLimit: Number(values.limit),
  });
  const report = await new VerificationService().run(input);
  process.stdout.write(
    JSON.stringify({
      runId: report.runId,
      overall: report.overall,
      source: report.source?.status,
      document: report.document?.status,
      model: report.model?.status,
    }) + "\n",
  );
  process.exitCode = report.overall === "passed" ? 0 : 2;
} catch {
  process.stderr.write(
    "验证输入非法、运行冲突或执行失败；未报告能力成功。检查本地锁及报告，不要盲目重试模型。\n",
  );
  process.exitCode = 1;
}
