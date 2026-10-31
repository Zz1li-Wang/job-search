import {
  CompletionSchema,
  StreamChunkSchema,
  MODEL_POLICY,
  ModelFailure,
  ModelProbeError,
  type Completion,
  type ModelConfig,
  type ModelRequestRecord,
  type ProbeMessage,
} from "./model-contracts.ts";
import { ModelRequestLedger } from "./model-ledger.ts";

export type ModelFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface CompletionOptions {
  messages: ProbeMessage[];
  response_format?: { type: "json_object" };
  tools?: object[];
}

/** SSE解码按事件边界而非网络块；UTF-8字符、CRLF和usage-only事件可跨块。 */
export async function readModelStream(
  response: Response,
): Promise<{ content: string; chunks: number; models: string[] }> {
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  )
    throw new ModelProbeError(ModelFailure.Stream);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let content = "";
  let chunks = 0;
  let done = false;
  let stopped = false;
  let bytes = 0;
  const models = new Set<string>();
  const consume = (event: string) => {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    if (data.trim() === "[DONE]") {
      done = true;
      return;
    }
    if (done) throw new ModelProbeError(ModelFailure.Stream);
    let chunk;
    try {
      chunk = StreamChunkSchema.parse(JSON.parse(data));
    } catch {
      throw new ModelProbeError(ModelFailure.Response);
    }
    if (chunk.model) models.add(chunk.model);
    for (const choice of chunk.choices) {
      if (choice.delta.content) {
        content += choice.delta.content;
        chunks += 1;
      }
      if (choice.finish_reason === "stop") stopped = true;
      else if (choice.finish_reason)
        throw new ModelProbeError(ModelFailure.Stream);
    }
  };
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        pending += decoder.decode();
        break;
      }
      bytes += part.value.length;
      if (bytes > MODEL_POLICY.maxResponseBytes)
        throw new ModelProbeError(ModelFailure.Output);
      pending += decoder.decode(part.value, { stream: true });
      pending = pending.replaceAll("\r\n", "\n");
      let index;
      while ((index = pending.indexOf("\n\n")) >= 0) {
        consume(pending.slice(0, index));
        pending = pending.slice(index + 2);
      }
    }
    if (pending.trim()) consume(pending);
    if (!done || !stopped || !content || chunks === 0)
      throw new ModelProbeError(ModelFailure.Stream);
    return { content, chunks, models: [...models] };
  } finally {
    await reader.cancel();
  }
}

/** 仅官方DeepSeek Chat Completions；禁止重定向、隐式重试和模型替换。 */
export class DeepSeekAdapter {
  readonly records: ModelRequestRecord[] = [];
  private readonly config: ModelConfig;
  private readonly ledger: ModelRequestLedger;
  private readonly runId: string;
  private readonly send: ModelFetch;
  constructor(
    config: ModelConfig,
    ledger: ModelRequestLedger,
    runId: string,
    send: ModelFetch = fetch,
  ) {
    this.config = config;
    this.ledger = ledger;
    this.runId = runId;
    this.send = send;
  }
  async complete(
    capability: string,
    options: CompletionOptions,
  ): Promise<Completion> {
    const { response, record } = await this.request(capability, options, false);
    try {
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (!reader) throw new ModelProbeError(ModelFailure.Response);
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > MODEL_POLICY.maxResponseBytes)
            throw new ModelProbeError(ModelFailure.Output);
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
      const completion = CompletionSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      this.checkModel(completion.model);
      record.responseModel = completion.model;
      record.usage = completion.usage;
      return completion;
    } catch (error) {
      const safe = this.normalize(error);
      record.errorCode = safe.code;
      throw safe;
    } finally {
      record.durationMs = Date.now() - Date.parse(record.startedAt);
    }
  }
  async stream(
    capability: string,
    options: CompletionOptions,
  ): Promise<{ content: string; chunks: number; models: string[] }> {
    const { response, record } = await this.request(capability, options, true);
    try {
      const output = await readModelStream(response);
      if (!output.models.length) throw new ModelProbeError(ModelFailure.Model);
      output.models.forEach((model) => this.checkModel(model));
      record.responseModel = output.models[0];
      return output;
    } catch (error) {
      const safe = this.normalize(error);
      record.errorCode = safe.code;
      throw safe;
    } finally {
      record.durationMs = Date.now() - Date.parse(record.startedAt);
    }
  }
  private async request(
    capability: string,
    options: CompletionOptions,
    stream: boolean,
  ) {
    if (
      options.messages.reduce(
        (total, message) => total + (message.content?.length ?? 0),
        0,
      ) > MODEL_POLICY.maxInputCharacters
    )
      throw new ModelProbeError(ModelFailure.Response);
    const sequence = await this.ledger.reserve(this.runId, capability);
    const record: ModelRequestRecord = {
      sequence,
      capability,
      startedAt: new Date().toISOString(),
      durationMs: 0,
    };
    this.records.push(record);
    try {
      const base = this.config.MODEL_BASE_URL.replace(/\/$/, "");
      const response = await this.send(`${base}/chat/completions`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(MODEL_POLICY.timeoutMs),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.MODEL_API_KEY}`,
        },
        body: JSON.stringify({
          ...options,
          model: this.config.MODEL_NAME,
          max_tokens: MODEL_POLICY.maxOutputTokens,
          thinking: { type: "disabled" },
          stream,
        }),
      });
      record.httpStatus = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        throw new ModelProbeError(ModelFailure.Http, response.status);
      }
      return { response, record };
    } catch (error) {
      const safe = this.normalize(error);
      record.errorCode = safe.code;
      record.durationMs = Date.now() - Date.parse(record.startedAt);
      throw safe;
    }
  }
  private checkModel(model: string): void {
    if (
      model !== this.config.MODEL_NAME &&
      !model.startsWith(this.config.MODEL_NAME + "-")
    )
      throw new ModelProbeError(ModelFailure.Model);
  }
  private normalize(error: unknown): ModelProbeError {
    if (error instanceof ModelProbeError) return error;
    if (
      error instanceof Error &&
      ["TimeoutError", "AbortError"].includes(error.name)
    )
      return new ModelProbeError(ModelFailure.Timeout);
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && error.name === "ZodError")
    )
      return new ModelProbeError(ModelFailure.Response);
    return new ModelProbeError(ModelFailure.Network);
  }
}
