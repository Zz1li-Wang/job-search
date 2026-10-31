import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PDFDocument } from "pdf-lib";
import { ProbeInputSchema } from "./dto.ts";
import { SourceBudget } from "./domain.ts";
import { SourceAdapter, inspectHtml, type SourceFetch } from "./source.ts";
import { extractDocument, validateDocxContainer } from "./documents.ts";
import { createFixtures, type Fixture } from "./fixtures.ts";
import { inspectModelConfiguration } from "./model.ts";
import { ReportStore } from "./report-store.ts";
import { VerificationService, probeDocuments } from "./service.ts";

let temporary: string;
let fixtures: Fixture[];
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "career-verifier-tests-"));
  fixtures = await createFixtures(join(temporary, "fixtures"));
});
afterAll(async () => {
  await rm(temporary, { recursive: true, force: true });
});

describe("VERIFY-01 来源策略、协议入口和来源替身", () => {
  it("超限robots响应不作为空策略允许继续抓取", async () => {
    const network = vi.fn<SourceFetch>(
      async () => new Response("x".repeat(3 * 1024 * 1024 + 1)),
    );
    const result = await new SourceAdapter(
      join(temporary, randomUUID()),
      20,
      network,
      async () => {},
    ).probe();
    expect(result.status).toBe("blocked");
    expect(result.pages[0].errorCode).toBe("source_body_too_large");
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("拒绝错误预算和非法命令DTO", () => {
    expect(() => new SourceBudget(21)).toThrow("invalid_request_budget");
    expect(
      ProbeInputSchema.safeParse({
        runId: "../escape",
        kind: "source",
        outputRoot: "/tmp",
      }).success,
    ).toBe(false);
  });
  it.each([
    "http://www.zhidianmijin.com.cn/",
    "https://localhost/",
    "https://127.0.0.1/",
    "https://www.zhidianmijin.com.cn.evil.test/",
    "https://u:p@www.zhidianmijin.com.cn/",
    "https://www.zhidianmijin.com.cn:123/",
  ])("拒绝非允许URL %s", (url) => {
    expect(() => new SourceBudget(2).authorize(url, 0)).toThrow(
      "source_url_forbidden",
    );
  });
  it("重定向也消耗预算且不访问非允许主机", async () => {
    const network = vi.fn<SourceFetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://localhost/secret" },
        }),
    );
    const adapter = new SourceAdapter(temporary, 2, network, async () => {});
    await expect(
      adapter.request("https://www.zhidianmijin.com.cn/"),
    ).rejects.toThrow("source_url_forbidden");
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("时间间隔和预算是领域不变量", () => {
    const budget = new SourceBudget(2);
    budget.authorize("https://www.zhidianmijin.com.cn/", 1_000);
    expect(
      budget.authorize("https://www.zhidianmijin.com.cn/jobs", 1_000),
    ).toBe(1_000);
    expect(() =>
      budget.authorize("https://www.zhidianmijin.com.cn/jobs", 2_000),
    ).toThrow("source_budget_exhausted");
  });
  it("请求耗尽产出blocked而不是继续联网", async () => {
    const network = vi.fn<SourceFetch>(
      async () => new Response("User-agent: *\nAllow: /"),
    );
    const result = await new SourceAdapter(
      join(temporary, randomUUID()),
      1,
      network,
      async () => {},
    ).probe();
    expect(result.status).toBe("blocked");
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("晚唤醒也从实际请求启动时刻限速", () => {
    const budget = new SourceBudget(2);
    budget.authorize("https://www.zhidianmijin.com.cn/", 1_000);
    budget.recordStartedAt(5_000);
    expect(
      budget.authorize("https://www.zhidianmijin.com.cn/jobs", 5_000),
    ).toBe(1_000);
  });
  it("网络失败及访问拒绝不伪装成功", async () => {
    for (const network of [
      async () => {
        throw new Error("offline");
      },
      async () => new Response("", { status: 429 }),
      async () => new Response("", { status: 403 }),
    ]) {
      const result = await new SourceAdapter(
        join(temporary, randomUUID()),
        2,
        network,
        async () => {},
      ).probe();
      expect(result.status).toBe("blocked");
      expect(result.requestCount).toBe(1);
    }
  });
  it("robots拒绝列表后不抓岗位", async () => {
    const network = vi.fn<SourceFetch>(
      async () => new Response("User-agent: *\nDisallow: /"),
    );
    const result = await new SourceAdapter(
      join(temporary, randomUUID()),
      20,
      network,
      async () => {},
    ).probe();
    expect(result.status).toBe("blocked");
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("只从实际HTML抽取招聘标签、链接与分页", () => {
    const info = inspectHtml(
      '<h1>研发</h1><span>招聘类型</span><span>校招</span><a href="/jobs?page=2&amp;x=1">下一页</a>',
      "https://www.zhidianmijin.com.cn/jobs",
    );
    expect(info.title).toBe("研发");
    expect(info.recruitmentType).toBe("campus");
    expect(info.paginationLinks[0]).toContain("&x=1");
  });
  it("HTTP200的登录页不算可用分页", async () => {
    const network: SourceFetch = async (url) => {
      if (url.endsWith("robots.txt"))
        return new Response("User-agent: *\nAllow: /");
      if (url.includes("page=2"))
        return new Response("<h1>登录后查看第 2 页岗位</h1>");
      if (url.endsWith("/jobs"))
        return new Response('<a href="/jobs?page=2">下一页</a>');
      if (url.endsWith("787b1a4b-53c0-9d9a-be12-2c5e1f8042a9"))
        return new Response("<h1>开发</h1>招聘类型 校招");
      return new Response("<h1>研究</h1>招聘类型 社招");
    };
    const result = await new SourceAdapter(
      join(temporary, randomUUID()),
      20,
      network,
      async () => {},
    ).probe();
    expect(result.status).toBe("blocked");
    expect(result.pages.some((page) => page.title?.includes("登录后"))).toBe(
      true,
    );
  });
});

describe("VERIFY-02 模型缺配置及未知协议不收费", () => {
  it("列出缺失配置名而不读取其他应用身份", () => {
    const result = inspectModelConfiguration({});
    expect(result.status).toBe("blocked");
    expect(result.requestCount).toBe(0);
    expect(result.missingConfiguration).toHaveLength(4);
  });
  it("配置存在也不冒充结构化、流式和工具已经验证", () => {
    const secret = "test-value-not-a-real-credential";
    const result = inspectModelConfiguration({
      MODEL_BASE_URL: "https://example.invalid",
      MODEL_NAME: "test",
      MODEL_API_KEY: secret,
      MODEL_PROTOCOL: "unknown",
    });
    expect(result.status).toBe("not_run");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.requestCount).toBe(0);
  });
});

describe("VERIFY-03 文档格式、证据定位及拒绝边界", () => {
  it("PDF超过30页直接拒绝，不进入逐页提取", async () => {
    const pdf = await PDFDocument.create();
    for (let index = 0; index < 31; index++) pdf.addPage();
    const path = join(temporary, "too-many-pages.pdf");
    await writeFile(path, await pdf.save());
    await expect(extractDocument(path)).rejects.toThrow("document_page_limit");
  });
  it.each(["text-txt", "text-docx", "text-pdf"])(
    "正确提取虚构简历 %s",
    async (id) => {
      const fixture = fixtures.find((entry) => entry.id === id)!;
      const spans = await extractDocument(fixture.path);
      expect(spans.some((span) => span.text.includes("Test Student"))).toBe(
        true,
      );
      expect(
        spans.every((span) => /^(page|paragraph):\d+$/.test(span.locator)),
      ).toBe(true);
      if (id !== "text-pdf")
        expect(spans.map((span) => span.text).join("")).toContain(
          "实习不能当作正式工作年限",
        );
    },
  );
  it.each([
    "image-only.pdf",
    "encrypted.pdf",
    "oversize.txt",
    "forged.pdf",
    "invalid-utf8.txt",
  ])("按明确原因拒绝 %s", async (id) => {
    const fixture = fixtures.find((entry) => entry.id === id)!;
    await expect(extractDocument(fixture.path)).rejects.toThrow(
      fixture.expectedCode,
    );
  });
  it("拒绝空DOCX和压缩容器资源膨胀", async () => {
    const empty = join(temporary, "empty.docx");
    await writeFile(empty, "");
    await expect(extractDocument(empty)).rejects.toThrow(
      "document_signature_mismatch",
    );
    const bytes = await readFile(join(temporary, "fixtures/resume.docx"));
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(0xffffffff, central + 24);
    expect(() => validateDocxContainer(bytes)).toThrow("docx_resource_limit");
  });
  it("空文本及字符超限不成功", async () => {
    const empty = join(temporary, "empty.txt");
    await writeFile(empty, " \n");
    await expect(extractDocument(empty)).rejects.toThrow("no_extractable_text");
    const long = join(temporary, "long.txt");
    await writeFile(long, "x".repeat(50_001));
    await expect(extractDocument(long)).rejects.toThrow(
      "document_character_limit",
    );
  });
  it("文档完整流程生成各样本及明确结果", async () => {
    const result = await probeDocuments(join(temporary, randomUUID()));
    expect(result.status).toBe("passed");
    expect(result.fixtures).toHaveLength(8);
  });
});

describe("报告事务、幂等、并发与E2E-VERIFY", () => {
  it("排他运行锁防止同ID同时执行", async () => {
    const store = new ReportStore(temporary, randomUUID());
    await store.acquire();
    await expect(store.acquire()).rejects.toThrow("probe_run_conflict");
    await store.release();
  });
  it("服务同请求复用报告，不同预算/能力冲突", async () => {
    const service = new VerificationService({});
    const input = {
      runId: randomUUID(),
      kind: "model" as const,
      outputRoot: temporary,
      requestLimit: 20,
    };
    const first = await service.run(input);
    expect(await service.run(input)).toEqual(first);
    await expect(service.run({ ...input, kind: "source" })).rejects.toThrow(
      "probe_run_payload_conflict",
    );
    await expect(service.run({ ...input, requestLimit: 19 })).rejects.toThrow(
      "probe_run_payload_conflict",
    );
  });
  it("锁内复查消除已完成报告的TOCTOU窗口", async () => {
    const input = {
      runId: randomUUID(),
      kind: "model" as const,
      outputRoot: temporary,
      requestLimit: 20,
    };
    const service = new VerificationService({});
    const saved = await service.run(input);
    const load = vi.spyOn(ReportStore.prototype, "load");
    load.mockResolvedValueOnce(undefined);
    expect(await service.run(input)).toEqual(saved);
    load.mockRestore();
  });
  it("损坏报告不当作通过且不自动再次收费", async () => {
    const store = new ReportStore(temporary, randomUUID());
    await mkdir(store.directory);
    await writeFile(join(store.directory, "report.json"), "{}");
    await expect(store.load()).rejects.toThrow("invalid_saved_report");
  });
  it("保存失败保留中断锁，重复运行不会重新执行", async () => {
    const service = new VerificationService({});
    const input = {
      runId: randomUUID(),
      kind: "model" as const,
      outputRoot: temporary,
      requestLimit: 20,
    };
    const save = vi
      .spyOn(ReportStore.prototype, "save")
      .mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(service.run(input)).rejects.toThrow("disk unavailable");
    save.mockRestore();
    await expect(service.run(input)).rejects.toThrow("probe_run_conflict");
  });
  it("实际CLI缺配置输出blocked和报告，重放不改变完成时间", async () => {
    const runId = randomUUID();
    const environment = { ...process.env };
    for (const key of [
      "MODEL_BASE_URL",
      "MODEL_NAME",
      "MODEL_API_KEY",
      "MODEL_PROTOCOL",
    ])
      delete environment[key];
    const command = () =>
      promisify(execFile)(
        process.execPath,
        [
          resolve("cli.ts"),
          "--kind",
          "model",
          "--run-id",
          runId,
          "--output",
          temporary,
        ],
        { env: environment, cwd: resolve(".") },
      );
    await expect(command()).rejects.toMatchObject({ code: 2 });
    const first = await readFile(join(temporary, runId, "report.json"), "utf8");
    await expect(command()).rejects.toMatchObject({ code: 2 });
    expect(await readFile(join(temporary, runId, "report.json"), "utf8")).toBe(
      first,
    );
    expect(JSON.parse(first).model.requestCount).toBe(0);
  });
  it("实际CLI文档路径经过提取、报告及manifest", async () => {
    const runId = randomUUID();
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        resolve("cli.ts"),
        "--kind",
        "document",
        "--run-id",
        runId,
        "--output",
        temporary,
      ],
      { cwd: resolve(".") },
    );
    expect(JSON.parse(stdout).document).toBe("passed");
    const manifest = JSON.parse(
      await readFile(join(temporary, runId, "manifest.json"), "utf8"),
    );
    expect(
      manifest.artifacts.some(
        (entry: { file: string }) => entry.file === "report.md",
      ),
    ).toBe(true);
  });
  it("非法CLI输入无报告也不联网", async () => {
    await expect(
      promisify(execFile)(
        process.execPath,
        [
          resolve("cli.ts"),
          "--kind",
          "arbitrary",
          "--run-id",
          "../escape",
          "--output",
          temporary,
        ],
        { cwd: resolve(".") },
      ),
    ).rejects.toMatchObject({ code: 1 });
  });
});
