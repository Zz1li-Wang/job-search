import { parseArgs } from "node:util";
import { probeSession } from "./session-service.ts";

try {
  const { values } = parseArgs({
    options: { "run-id": { type: "string" }, output: { type: "string" } },
  });
  const report = await probeSession(
    { runId: values["run-id"], outputRoot: values.output },
    process.env,
  );
  console.log(
    JSON.stringify({
      runId: report.runId,
      status: report.status,
      anonymous: report.before.category,
      authenticated: report.after.category,
      authenticatedJobs: report.after.jobIds.length,
      requestCount: report.requestCount,
      cumulativeSourceRequests: report.cumulativeSourceRequests,
    }),
  );
  process.exitCode = report.status === "passed" ? 0 : 2;
} catch {
  console.error(
    "来源会话验证未完成：请检查私有配置、锁、报告或剩余预算；未输出Cookie或原始响应。",
  );
  process.exitCode = 1;
}
