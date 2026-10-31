import { appendFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  MODEL_POLICY,
  ModelFailure,
  ModelProbeError,
} from "./model-contracts.ts";

const AttemptSchema = z.object({
  runId: z.uuid().describe("所属验证运行"),
  sequence: z.number().int().positive().describe("全局计费尝试序号"),
  capability: z.string().describe("能力名称"),
  startedAt: z.iso.datetime().describe("请求前预留时刻"),
});
/** 网络前持久化预留；崩溃后的未知尝试也占额度，杜绝换runId重置预算。 */
export class ModelRequestLedger {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  async reserve(runId: string, capability: string): Promise<number> {
    await mkdir(this.root, { recursive: true });
    const lock = join(this.root, ".model-budget.lock");
    let handle;
    try {
      handle = await open(lock, "wx", 0o600);
    } catch {
      throw new ModelProbeError(ModelFailure.Ledger);
    }
    try {
      let contents = "";
      try {
        contents = await readFile(
          join(this.root, "model-request-ledger.jsonl"),
          "utf8",
        );
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw new ModelProbeError(ModelFailure.Ledger);
      }
      let attempts;
      try {
        attempts = contents
          .split("\n")
          .filter(Boolean)
          .map((line) => AttemptSchema.parse(JSON.parse(line)));
      } catch {
        throw new ModelProbeError(ModelFailure.Ledger);
      }
      if (attempts.length >= MODEL_POLICY.maxRequests)
        throw new ModelProbeError(ModelFailure.Budget);
      const attempt = AttemptSchema.parse({
        runId,
        sequence: attempts.length + 1,
        capability,
        startedAt: new Date().toISOString(),
      });
      await appendFile(
        join(this.root, "model-request-ledger.jsonl"),
        JSON.stringify(attempt) + "\n",
        { mode: 0o600 },
      );
      return attempt.sequence;
    } finally {
      await handle.close();
      await unlink(lock);
    }
  }
}
