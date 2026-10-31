import type { Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { HTTP_BODY_POLICY } from '@career/contracts';
import { EXECUTION_POLICY } from '@career/contracts';
import { timingSafeEqual, createHash } from 'node:crypto';
import {
  Controller,
  Module,
  Post,
  Get,
  Param,
  Body,
  Headers,
  Req,
  Res,
  HttpStatus,
  Inject,
  HttpCode,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  type DynamicModule,
} from '@nestjs/common';
import {
  AgentRunInputSchema,
  ExtractionInputSchema,
  AgentStateSchema,
  ResourcePathSchema,
  ExtractionFailureCodeSchema,
} from '@career/contracts';
import {
  AgentEngine,
  AgentFailure,
  extractResumeProfile,
  createBusinessHealthProbe,
} from '@career/agent-core';
import type { AgentConfig } from '@career/config';
import {
  createHealthApplication,
  HealthService,
  createSafeLogger,
} from '@career/observability';
function valid<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException();
  return parsed.data;
}
const RUNTIME = Symbol('agent-runtime');
export class AgentRuntime {
  private readonly logger = createSafeLogger('agent');
  private readonly runs = new Map<
    string,
    {
      controller: AbortController;
      status: 'running' | 'completed' | 'failed' | 'cancelled';
      hash: string;
    }
  >();
  private readonly extractions = new Map<
    string,
    {
      hash: string;
      status: 'running' | 'completed' | 'failed' | 'cancelled';
      controller: AbortController;
      promise: ReturnType<typeof extractResumeProfile> | null;
    }
  >();
  constructor(
    private readonly config: AgentConfig,
    private readonly engine = new AgentEngine(config),
  ) {}
  authenticate(header: unknown) {
    if (
      typeof header !== 'string' ||
      !timingSafeEqual(
        createHash('sha256').update(header).digest(),
        createHash('sha256')
          .update(`Bearer ${this.config.SERVICE_AUTH_TOKEN}`)
          .digest(),
      )
    )
      throw new ForbiddenException();
  }
  start(raw: unknown) {
    const input = valid(AgentRunInputSchema, raw),
      hash = createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      old = this.runs.get(input.runId);
    if (old) {
      if (old.hash !== hash) throw new ConflictException();
      return this.state(input.runId);
    }
    if (this.runs.size > 1000) {
      for (const [id, run] of this.runs) {
        if (run.status !== 'running') this.runs.delete(id);
        if (this.runs.size < 500) break;
      }
      if (this.runs.size > 1000) throw new ServiceUnavailableException();
    }
    const controller = new AbortController(),
      run = {
        controller,
        status: 'running' as 'running' | 'completed' | 'failed' | 'cancelled',
        hash,
      };
    this.runs.set(input.runId, run);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(EXECUTION_POLICY.agentTimeoutMs),
    ]);
    void this.engine.execute(input, signal).then(
      () => {
        if (run.status === 'running') run.status = 'completed';
      },
      (error: unknown) => {
        if (run.status === 'running') run.status = 'failed';
        this.logger.warn(
          {
            runId: input.runId,
            code:
              error instanceof AgentFailure ? error.code : 'MODEL_UNAVAILABLE',
          },
          'chat_run_failed',
        );
      },
    );
    return this.state(input.runId);
  }
  state(id: string) {
    return AgentStateSchema.parse({
      runId: id,
      status: this.runs.get(id)?.status ?? 'unknown',
    });
  }
  cancel(id: string) {
    const extraction = this.extractions.get(id);
    if (extraction?.status === 'running') {
      extraction.status = 'cancelled';
      extraction.controller.abort();
    }
    const run = this.runs.get(id);
    if (run?.status === 'running') {
      run.status = 'cancelled';
      run.controller.abort();
    }
    return this.state(id);
  }
  async extract(raw: unknown) {
    const input = valid(ExtractionInputSchema, raw),
      hash = createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      old = this.extractions.get(input.runId);
    if (old) {
      if (old.hash !== hash || !old.promise) throw new ConflictException();
      return old.promise;
    }
    if (this.extractions.size >= 1000) {
      for (const [id, entry] of this.extractions) {
        if (entry.status !== 'running') this.extractions.delete(id);
        if (this.extractions.size < 500) break;
      }
      if (this.extractions.size >= 1000)
        throw new ServiceUnavailableException();
    }
    const controller = new AbortController(),
      entry: {
        hash: string;
        status: 'running' | 'completed' | 'failed' | 'cancelled';
        controller: AbortController;
        promise: ReturnType<typeof extractResumeProfile> | null;
      } = { hash, status: 'running', controller, promise: null };
    const promise = extractResumeProfile(
      this.config,
      input,
      AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(EXECUTION_POLICY.agentTimeoutMs),
      ]),
    );
    entry.promise = promise;
    this.extractions.set(input.runId, entry);
    try {
      const answer = await promise;
      entry.status = 'completed';
      return answer;
    } catch (error) {
      entry.status = controller.signal.aborted ? 'cancelled' : 'failed';
      const failureCode = ExtractionFailureCodeSchema.safeParse(
        error instanceof AgentFailure ? error.code : 'MODEL_INTERRUPTED',
      );
      this.logger.warn(
        {
          runId: input.runId,
          code: failureCode.success ? failureCode.data : 'MODEL_INTERRUPTED',
        },
        'resume_extraction_failed',
      );
      throw error;
    } finally {
      entry.promise = null;
    }
  }
  close() {
    for (const run of this.runs.values()) run.controller.abort();
    for (const extraction of this.extractions.values())
      extraction.controller.abort();
  }
}
@Controller('internal/v1/runs')
export class AgentController {
  constructor(@Inject(RUNTIME) private readonly runtime: AgentRuntime) {}
  @Post() @HttpCode(202) start(
    @Body() body: unknown,
    @Headers('authorization') auth: unknown,
  ) {
    this.runtime.authenticate(auth);
    return this.runtime.start(body);
  }
  @Get(':id') state(
    @Param() path: unknown,
    @Headers('authorization') auth: unknown,
  ) {
    this.runtime.authenticate(auth);
    return this.runtime.state(valid(ResourcePathSchema, path).id);
  }
  @Post(':id/cancel') @HttpCode(200) cancel(
    @Param() path: unknown,
    @Headers('authorization') auth: unknown,
  ) {
    this.runtime.authenticate(auth);
    return this.runtime.cancel(valid(ResourcePathSchema, path).id);
  }
}
@Controller('internal/v1/resume-extractions')
export class ExtractionController {
  constructor(@Inject(RUNTIME) private readonly runtime: AgentRuntime) {}
  @Post() @HttpCode(200) async extract(
    @Body() body: unknown,
    @Headers('authorization') auth: unknown,
    @Req() request: { requestId: string },
    @Res({ passthrough: true }) response: Response,
  ) {
    this.runtime.authenticate(auth);
    try {
      return await this.runtime.extract(body);
    } catch (error) {
      const code = ExtractionFailureCodeSchema.safeParse(
        error instanceof AgentFailure ? error.code : null,
      );
      if (!code.success) throw error;
      response.status(HttpStatus.BAD_GATEWAY);
      return {
        requestId: request.requestId,
        error: {
          code: code.data,
          message: '简历结构化未完成，请按错误类型检查资料后显式重试',
        },
      };
    }
  }
}
@Module({})
class AgentModule {
  static register(runtime: AgentRuntime): DynamicModule {
    return {
      module: AgentModule,
      controllers: [AgentController, ExtractionController],
      providers: [{ provide: RUNTIME, useValue: runtime }],
    };
  }
}
export async function createAgentApplication(config: AgentConfig) {
  const runtime = new AgentRuntime(config);
  const app = await createHealthApplication(
    {
      health: new HealthService('agent', [createBusinessHealthProbe(config)]),
      authentication: {
        token: config.SERVICE_AUTH_TOKEN,
        scopes: ['health:read'],
      },
    },
    [AgentModule.register(runtime)],
  );
  (app as NestExpressApplication).useBodyParser('json', {
    limit: HTTP_BODY_POLICY.agentJsonBytes,
  });
  return {
    app,
    async close() {
      runtime.close();
      await app.close();
    },
  };
}
