import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  ModelConfigSchema,
  ModelFailure,
  MODEL_POLICY,
  type ModelConfig,
} from "./model-contracts.ts";
import { ModelRequestLedger } from "./model-ledger.ts";
import {
  DeepSeekAdapter,
  readModelStream,
  type ModelFetch,
} from "./deepseek.ts";
import { ResumeProbeEvidence } from "./model-evidence.ts";
import { SAMPLE_LINES } from "./fixtures.ts";
import { probeModel } from "./model-probe.ts";
import { VerificationService } from "./service.ts";

let temporary: string;
const fakeKey = "fake-credential-only-for-controlled-tests";
const config: ModelConfig = {
  MODEL_BASE_URL: "https://api.deepseek.com",
  MODEL_NAME: "deepseek-v4-pro",
  MODEL_PROTOCOL: "deepseek-chat-completions",
  MODEL_API_KEY: fakeKey,
};
const extraction = {
  name: "Test Student",
  degree: "bachelor",
  major: "computer_science",
  expectedGraduation: "2027-06",
  formalExperienceYears: 0,
  hasInternship: true,
  evidence: [
    { field: "name", locator: "paragraph:2", quote: SAMPLE_LINES[1] },
    ...["degree", "major", "expectedGraduation"].map((field) => ({
      field,
      locator: "paragraph:3",
      quote: SAMPLE_LINES[2],
    })),
    {
      field: "formalExperienceYears",
      locator: "paragraph:6",
      quote: SAMPLE_LINES[5],
    },
    { field: "hasInternship", locator: "paragraph:4", quote: SAMPLE_LINES[3] },
  ],
};
const audit = {
  school: null,
  birthDate: null,
  phone: null,
  formalExperienceYears: 0,
  graduationKind: "expected",
  evidenceQuote: SAMPLE_LINES[5],
};
const toolCall = {
  id: "fixture-tool-call",
  type: "function",
  function: { name: "get_probe_fact", arguments: '{"probeId":"fixture-1"}' },
};
function completion(
  content: string | null,
  calls?: object[],
  finish = "stop",
  model = "deepseek-v4-pro",
) {
  return Response.json({
    model,
    choices: [
      {
        message: {
          role: "assistant",
          content,
          tool_calls: calls,
          reasoning_content: "must-not-be-retained",
        },
        finish_reason: finish,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
}
function stream(events?: string): Response {
  return new Response(
    events ??
      `data: ${JSON.stringify({ model: "deepseek-v4-pro", choices: [{ delta: { content: "stream_ready 中文验证" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}
function successfulNetwork(): ModelFetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init.body));
    if (body.stream) return stream();
    if (body.tools) {
      const result = body.messages.find(
        (message: { role: string }) => message.role === "tool",
      );
      return result
        ? completion(result.content)
        : completion(null, [toolCall], "tool_calls");
    }
    const text = body.messages
      .map((message: { content: string }) => message.content)
      .join("");
    return completion(
      JSON.stringify(text.includes("graduationKind") ? audit : extraction),
    );
  };
}
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "career-model-tests-"));
});
afterAll(async () => {
  await rm(temporary, { recursive: true, force: true });
});

describe("模型配置与全局请求账本", () => {
  it("两个独立进程竞争同一账本不重复预留序号", async () => {
    const root = join(temporary, randomUUID());
    await mkdir(root);
    const script =
      'const {ModelRequestLedger}=await import(process.argv[1]);try{const sequence=await new ModelRequestLedger(process.argv[2]).reserve(process.argv[3],"process-test");console.log(JSON.stringify({pid:process.pid,sequence}));}catch{console.log(JSON.stringify({pid:process.pid,blocked:true}));}';
    const invoke = () =>
      promisify(execFile)(process.execPath, [
        "--input-type=module",
        "-e",
        script,
        pathToFileURL(resolve("model-ledger.ts")).href,
        root,
        randomUUID(),
      ]);
    const outputs = await Promise.all([invoke(), invoke()]);
    const results = outputs.map((output) => JSON.parse(output.stdout));
    const rows = (
      await readFile(join(root, "model-request-ledger.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(new Set(results.map((result) => result.pid)).size).toBe(2);
    expect(rows.length).toBe(
      results.filter((result) => result.sequence).length,
    );
    expect(new Set(rows.map((row) => row.sequence)).size).toBe(rows.length);
  });
  it("只接受用户指定模型和官方端点", () => {
    expect(ModelConfigSchema.safeParse(config).success).toBe(true);
    for (const change of [
      { MODEL_NAME: "deepseek-flash" },
      { MODEL_BASE_URL: "https://evil.invalid" },
      { MODEL_BASE_URL: "https://api.deepseek.com.evil.invalid" },
      { MODEL_BASE_URL: "https://u:p@api.deepseek.com" },
      { MODEL_PROTOCOL: "unknown" },
    ])
      expect(
        ModelConfigSchema.safeParse({ ...config, ...change }).success,
      ).toBe(false);
  });
  it("第五次以后换runId也不能重置额度", async () => {
    const ledger = new ModelRequestLedger(join(temporary, randomUUID()));
    for (let index = 0; index < MODEL_POLICY.maxRequests; index++)
      expect(await ledger.reserve(randomUUID(), "fixture")).toBe(index + 1);
    await expect(ledger.reserve(randomUUID(), "fixture")).rejects.toThrow(
      ModelFailure.Budget,
    );
  });
  it("并发预留不产生重复全局序号", async () => {
    const root = join(temporary, randomUUID());
    const ledger = new ModelRequestLedger(root);
    await mkdir(root);
    const results = await Promise.allSettled([
      ledger.reserve(randomUUID(), "a"),
      ledger.reserve(randomUUID(), "b"),
    ]);
    const rows = (
      await readFile(join(root, "model-request-ledger.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(new Set(rows.map((row) => row.sequence)).size).toBe(rows.length);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  });
  it("损坏账本拒绝继续，而不是清空预算", async () => {
    const root = join(temporary, randomUUID());
    await mkdir(root);
    await writeFile(join(root, "model-request-ledger.jsonl"), "broken");
    await expect(
      new ModelRequestLedger(root).reserve(randomUUID(), "test"),
    ).rejects.toThrow(ModelFailure.Ledger);
  });
});

describe("SSE协议与流中断", () => {
  it("UTF-8中文、CRLF和事件可跨网络块，忽略推理字段", async () => {
    const events = `: heartbeat\r\n\r\ndata: ${JSON.stringify({ model: "deepseek-v4-pro", choices: [{ delta: { content: "中文", reasoning_content: "not-saved" }, finish_reason: null }] })}\r\n\r\ndata: ${JSON.stringify({ choices: [], usage: { total_tokens: 1 } })}\r\n\r\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const bytes = new TextEncoder().encode(events);
    const body = new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const result = await readModelStream(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
    expect(result.content).toBe("中文");
    expect(JSON.stringify(result)).not.toContain("not-saved");
  });
  it.each([
    "data: [DONE]\n\n",
    "data: {broken}\n\n",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "incomplete" }, finish_reason: null }] })}\n\n`,
  ])("缺完整结束或非法事件不通过", async (events) => {
    await expect(readModelStream(stream(events))).rejects.toThrow();
  });
  it("非事件流被拒绝", async () => {
    await expect(
      readModelStream(Response.json({ content: "wrong" })),
    ).rejects.toThrow(ModelFailure.Stream);
  });
});

describe("DeepSeek网络适配器", () => {
  it("只发指定模型、关闭思考、限制输出和禁止重定向，响应不存推理", async () => {
    const network = vi.fn<ModelFetch>(async () => completion("ok"));
    const adapter = new DeepSeekAdapter(
      config,
      new ModelRequestLedger(join(temporary, randomUUID())),
      randomUUID(),
      network,
    );
    const result = await adapter.complete("fixture", {
      messages: [{ role: "user", content: "test" }],
    });
    const [url, init] = network.mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init.redirect).toBe("error");
    expect(body.model).toBe("deepseek-v4-pro");
    expect(body.max_tokens).toBe(1500);
    expect(body.thinking.type).toBe("disabled");
    expect(JSON.stringify(result)).not.toContain("must-not-be-retained");
    expect(JSON.stringify(adapter.records)).not.toContain(fakeKey);
  });
  it("输入超限前不预留或发送请求", async () => {
    const network = vi.fn<ModelFetch>();
    const adapter = new DeepSeekAdapter(
      config,
      new ModelRequestLedger(join(temporary, randomUUID())),
      randomUUID(),
      network,
    );
    await expect(
      adapter.complete("fixture", {
        messages: [{ role: "user", content: "a".repeat(6001) }],
      }),
    ).rejects.toThrow(ModelFailure.Response);
    expect(network).not.toHaveBeenCalled();
  });
  it.each([401, 403, 429, 500])(
    "HTTP %s 记录状态但不保存外部错误正文和密钥",
    async (status) => {
      const network = vi.fn<ModelFetch>(
        async () => new Response(`reflected secret ${fakeKey}`, { status }),
      );
      const adapter = new DeepSeekAdapter(
        config,
        new ModelRequestLedger(join(temporary, randomUUID())),
        randomUUID(),
        network,
      );
      await expect(
        adapter.complete("fixture", {
          messages: [{ role: "user", content: "x" }],
        }),
      ).rejects.toMatchObject({ code: ModelFailure.Http, httpStatus: status });
      expect(network).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(adapter.records)).not.toContain(fakeKey);
    },
  );
  it("超时只记录一次，不自动重试或输出原异常", async () => {
    const network = vi.fn<ModelFetch>(async () => {
      throw new DOMException(fakeKey, "TimeoutError");
    });
    const adapter = new DeepSeekAdapter(
      config,
      new ModelRequestLedger(join(temporary, randomUUID())),
      randomUUID(),
      network,
    );
    await expect(
      adapter.complete("fixture", {
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toThrow(ModelFailure.Timeout);
    expect(network).toHaveBeenCalledTimes(1);
    expect(adapter.records[0].errorCode).toBe(ModelFailure.Timeout);
  });
  it("服务返回Flash不作为Pro通过", async () => {
    const adapter = new DeepSeekAdapter(
      config,
      new ModelRequestLedger(join(temporary, randomUUID())),
      randomUUID(),
      async () => completion("wrong", undefined, "stop", "deepseek-flash"),
    );
    await expect(
      adapter.complete("fixture", {
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toThrow(ModelFailure.Model);
  });
  it("非法JSON不会变成成功", async () => {
    const adapter = new DeepSeekAdapter(
      config,
      new ModelRequestLedger(join(temporary, randomUUID())),
      randomUUID(),
      async () => new Response("broken"),
    );
    await expect(
      adapter.complete("fixture", {
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toThrow(ModelFailure.Response);
  });
});

describe("字段与原文依据的领域判断", () => {
  const checker = new ResumeProbeEvidence(
    SAMPLE_LINES.map((text, index) => ({
      locator: `paragraph:${index + 1}`,
      text,
    })),
  );
  it("固定夹具事实、逐字段定位和未知字段均可验证", () => {
    expect(checker.validateExtraction(extraction)).toEqual(extraction);
    expect(checker.validateAudit(audit)).toEqual(audit);
  });
  it("学历事实正确但引用其他字段也拒绝", () => {
    const wrong = structuredClone(extraction);
    wrong.evidence[1] = {
      field: "degree",
      locator: "paragraph:2",
      quote: SAMPLE_LINES[1],
    };
    expect(() => checker.validateExtraction(wrong)).toThrow(ModelFailure.Facts);
  });
  it("伪造引用、实习计正式工作、未知学校生日不接受", () => {
    const wrong = structuredClone(extraction);
    wrong.evidence[0].quote = "not-in-original";
    expect(() => checker.validateExtraction(wrong)).toThrow(ModelFailure.Facts);
    expect(() =>
      checker.validateExtraction({ ...extraction, formalExperienceYears: 1 }),
    ).toThrow(ModelFailure.Facts);
    expect(() =>
      checker.validateAudit({ ...audit, school: "guessed" }),
    ).toThrow(ModelFailure.Facts);
    expect(() =>
      checker.validateAudit({ ...audit, evidenceQuote: SAMPLE_LINES[0] }),
    ).toThrow(ModelFailure.Facts);
  });
});

describe("VERIFY-02及E2E-VERIFY模型入口", () => {
  it("缺配置和错误协议不触发网络", async () => {
    const root = join(temporary, randomUUID());
    const network = vi.fn<ModelFetch>();
    expect(
      (await probeModel(root, root, randomUUID(), {}, network)).status,
    ).toBe("blocked");
    expect(
      (
        await probeModel(
          root,
          root,
          randomUUID(),
          { ...config, MODEL_PROTOCOL: "unknown" },
          network,
        )
      ).status,
    ).toBe("blocked");
    expect(network).not.toHaveBeenCalled();
  });
  it("真实编排经5次可控请求验证工具随机凭证回传并保存证据", async () => {
    const root = join(temporary, randomUUID());
    const network = vi.fn<ModelFetch>(successfulNetwork());
    const runId = randomUUID();
    const report = await new VerificationService(
      config,
      undefined,
      network,
    ).run({ runId, kind: "model", outputRoot: root, requestLimit: 20 });
    expect(report.model?.status).toBe("passed");
    expect(network).toHaveBeenCalledTimes(5);
    const evidence = await readFile(
      join(root, runId, "model/evidence.json"),
      "utf8",
    );
    const parsed = JSON.parse(evidence);
    expect(
      parsed.checks.every(
        (check: { status: string }) => check.status === "passed",
      ),
    ).toBe(true);
    expect(parsed.outputs.toolReturn.proof).toBeTruthy();
    expect(evidence).not.toContain(fakeKey);
    expect(evidence).not.toContain("must-not-be-retained");
    expect(
      await new VerificationService(config, undefined, network).run({
        runId,
        kind: "model",
        outputRoot: root,
        requestLimit: 20,
      }),
    ).toEqual(report);
    expect(network).toHaveBeenCalledTimes(5);
  });
  it("认证失败后停止其余项目，报告不伪称通过", async () => {
    const root = join(temporary, randomUUID());
    const network = vi.fn<ModelFetch>(
      async () => new Response(fakeKey, { status: 401 }),
    );
    const report = await probeModel(
      join(root, "run"),
      root,
      randomUUID(),
      config,
      network,
    );
    expect(report.status).toBe("failed");
    expect(report.requestCount).toBe(1);
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("未知工具不执行，也不伪造回传验证", async () => {
    const root = join(temporary, randomUUID());
    const success = successfulNetwork();
    const network: ModelFetch = async (url, init) => {
      const body = JSON.parse(String(init.body));
      return body.tools
        ? completion(
            null,
            [
              {
                ...toolCall,
                function: { name: "delete_user", arguments: "{}" },
              },
            ],
            "tool_calls",
          )
        : success(url, init);
    };
    const result = await probeModel(
      join(root, "run"),
      root,
      randomUUID(),
      config,
      network,
    );
    const evidence = JSON.parse(
      await readFile(join(root, "run/model/evidence.json"), "utf8"),
    );
    expect(result.status).toBe("failed");
    expect(result.requestCount).toBe(4);
    expect(
      evidence.checks.find(
        (check: { name: string }) => check.name === "tool_result_return",
      ).status,
    ).toBe("not_run");
  });
});
