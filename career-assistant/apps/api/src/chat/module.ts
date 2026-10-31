import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  Controller,
  Module,
  Post,
  Get,
  Delete,
  Param,
  Query,
  Body,
  Req,
  Res,
  Headers,
  Inject,
  UseGuards,
  UseFilters,
  HttpCode,
  ForbiddenException,
  type DynamicModule,
} from '@nestjs/common';
import type { Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  createChatServices,
  createJobsServices,
  IngestionServices,
} from '@career/business';
import {
  ConversationInputSchema,
  MessageInputSchema,
  ResourcePathSchema,
  RetryRunSchema,
  EventCursorSchema,
  RunEventInputSchema,
  EmptyInputSchema,
  JobQuerySchema,
  EvaluateInputSchema,
  OperationKeySchema,
  ProposeProfileSchema,
} from '@career/contracts';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  AuthGuard,
  AuthExceptionFilter,
  ContextOperation,
  caller,
  validated,
  type AuthRequest,
} from '../auth/module.js';
import { BusinessExceptionFilter } from '../jobs/module.js';
const CHAT = Symbol('chat-options');
export interface ChatHttpOptions {
  services: ReturnType<typeof createChatServices>;
  jobs: ReturnType<typeof createJobsServices>;
  ingestion: IngestionServices;
  resumes: ReturnType<typeof import('@career/business').createResumeServices>;
  serviceToken: string;
}
function serviceAuth(header: unknown, token: string) {
  if (
    typeof header !== 'string' ||
    !timingSafeEqual(
      createHash('sha256').update(header).digest(),
      createHash('sha256').update(`Bearer ${token}`).digest(),
    )
  )
    throw new ForbiddenException();
}
@Controller('api/v1')
@UseGuards(AuthGuard)
@UseFilters(BusinessExceptionFilter, AuthExceptionFilter)
export class ChatController {
  constructor(@Inject(CHAT) private readonly options: ChatHttpOptions) {}
  @Post('conversations') @ContextOperation('write') async create(
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.options.services.chat.create(
        validated(ConversationInputSchema, body).title,
        caller(r).actor!,
        key === undefined ? undefined : validated(OperationKeySchema, key),
      ),
    };
  }
  @Get('conversations') @ContextOperation('session') async list(
    @Query() q: unknown,
    @Req() r: AuthRequest,
  ) {
    validated(EmptyInputSchema, q);
    return {
      requestId: r.requestId,
      payload: await this.options.services.chat.list(caller(r).actor!),
    };
  }
  @Delete('conversations/:id')
  @HttpCode(204)
  @ContextOperation('write')
  async remove(@Param() p: unknown, @Req() r: AuthRequest) {
    await this.options.services.chat.remove(
      validated(ResourcePathSchema, p).id,
      caller(r).actor!,
    );
  }
  @Get('conversations/:id/messages')
  @ContextOperation('session')
  async messages(@Param() p: unknown, @Req() r: AuthRequest) {
    return {
      requestId: r.requestId,
      payload: await this.options.services.chat.messages(
        validated(ResourcePathSchema, p).id,
        caller(r).actor!,
      ),
    };
  }
  @Post('conversations/:id/messages')
  @HttpCode(202)
  @ContextOperation('write')
  async send(@Param() p: unknown, @Body() b: unknown, @Req() r: AuthRequest) {
    return {
      requestId: r.requestId,
      payload: await this.options.services.chat.send(
        validated(ResourcePathSchema, p).id,
        validated(MessageInputSchema, b),
        caller(r).actor!,
      ),
    };
  }
  @Get('runs/:id') @ContextOperation('session') async run(
    @Param() p: unknown,
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.options.services.chat.getRun(
        validated(ResourcePathSchema, p).id,
        caller(r).actor!,
      ),
    };
  }
  @Post('runs/:id/cancel')
  @HttpCode(200)
  @ContextOperation('write')
  async cancel(@Param() p: unknown, @Body() b: unknown, @Req() r: AuthRequest) {
    validated(EmptyInputSchema, b);
    return {
      requestId: r.requestId,
      payload: await this.options.services.chat.cancel(
        validated(ResourcePathSchema, p).id,
        caller(r).actor!,
      ),
    };
  }
  @Post('runs/:id/retry') @HttpCode(202) @ContextOperation('write') async retry(
    @Param() p: unknown,
    @Body() b: unknown,
    @Req() r: AuthRequest,
  ) {
    return {
      requestId: r.requestId,
      payload: await this.options.services.chat.retry(
        validated(ResourcePathSchema, p).id,
        validated(RetryRunSchema, b).expectedRunVersion,
        caller(r).actor!,
      ),
    };
  }
  @Get('runs/:id/events') @ContextOperation('session') async events(
    @Param() p: unknown,
    @Query() q: unknown,
    @Headers('last-event-id') last: unknown,
    @Req() r: AuthRequest,
    @Res() response: Response,
  ) {
    const id = validated(ResourcePathSchema, p).id;
    let after = validated(EventCursorSchema, q).after;
    if (last !== undefined) {
      const parsed = validated(
        z.string().regex(new RegExp(`^${id}:[0-9]+$`)),
        last,
      );
      after = Math.max(after, Number(parsed.split(':')[1]));
    }
    const actor = caller(r).actor!;
    await this.options.services.chat.getRun(id, actor);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    let isClosed = false;
    response.on('close', () => {
      isClosed = true;
    });
    const started = Date.now();
    try {
      while (!isClosed && Date.now() - started < 25000) {
        const batch = await this.options.services.chat.events(id, after, actor);
        for (const event of batch) {
          response.write(
            `id: ${id}:${event.sequence}\nevent: ${event.payload.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
          after = event.sequence;
        }
        const run = await this.options.services.chat.getRun(id, actor);
        if (
          !['queued', 'running'].includes(run.status) &&
          after >= run.lastSequence
        )
          break;
        response.write(': heartbeat\n\n');
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    } catch {
      if (!isClosed) response.write('event: access_revoked\ndata: {}\n\n');
    } finally {
      response.end();
    }
  }
}
@Controller()
@UseFilters(BusinessExceptionFilter)
export class AgentCallbackController {
  constructor(@Inject(CHAT) private readonly options: ChatHttpOptions) {}
  @Post('internal/v1/runs/:id/events') @HttpCode(200) async append(
    @Param() p: unknown,
    @Body() b: unknown,
    @Headers('authorization') auth: unknown,
    @Headers('x-run-grant') grant: unknown,
  ) {
    serviceAuth(auth, this.options.serviceToken);
    return this.options.services.chat.append(
      validated(ResourcePathSchema, p).id,
      validated(z.string().max(5000), grant),
      validated(RunEventInputSchema, b),
    );
  }
}
@Controller('mcp')
@UseFilters(BusinessExceptionFilter)
export class McpController {
  constructor(@Inject(CHAT) private readonly options: ChatHttpOptions) {}
  @Post() async handle(
    @Body() body: unknown,
    @Headers('authorization') auth: unknown,
    @Headers('x-run-grant') rawGrant: unknown,
    @Req() request: AuthRequest,
    @Res() response: Response,
  ) {
    serviceAuth(auth, this.options.serviceToken);
    const grant = validated(z.string().max(5000), rawGrant),
      authorization =
        await this.options.services.authorization.authorize(grant);
    const server = new McpServer({ name: 'career-business', version: '0.1.0' });
    const register = (
      name:
        | 'get_profile'
        | 'search_jobs'
        | 'get_job_evidence'
        | 'evaluate_eligibility'
        | 'request_job_refresh'
        | 'get_task_status'
        | 'read_resume'
        | 'propose_profile_update',
      description: string,
      shape: z.ZodRawShape,
      execute: (
        input: unknown,
        actor: typeof authorization.actor,
      ) => Promise<unknown>,
    ) => {
      if (!authorization.tools.includes(name)) return;
      server.registerTool(
        name,
        { description, inputSchema: z.strictObject(shape) },
        async (input: unknown): Promise<CallToolResult> => {
          try {
            const { actor } =
              await this.options.services.authorization.authorize(grant, name);
            const payload = await execute(input, actor);
            return {
              content: [
                { type: 'text' as const, text: JSON.stringify(payload) },
              ],
            };
          } catch (error) {
            const code =
              error instanceof Error && 'code' in error
                ? String(error.code)
                : 'TOOL_FAILED';
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: { code, message: '工具执行失败，不能推断条件满足' },
                  }),
                },
              ],
            };
          }
        },
      );
    };
    register(
      'get_profile',
      '读取本人已确认画像；未确认简历不生效，无资料返回版本0。只读，可重复。',
      {},
      (_input, actor) => this.options.jobs.profile.execute(actor),
    );
    register(
      'search_jobs',
      '查询已收录校招和社招候选岗位，不表示报名资格。只读，可重复。',
      JobQuerySchema.shape,
      (input, actor) =>
        this.options.jobs.jobs.list(JobQuerySchema.parse(input), actor),
    );
    register(
      'get_job_evidence',
      '读取岗位原文、公告、实际版本及观察ID；未知来源不得虚构。只读，可重复。',
      { jobId: z.uuid().describe('已查询的岗位ID') },
      (input, actor) =>
        this.options.jobs.jobs.evidence(
          z.object({ jobId: z.uuid() }).parse(input).jobId,
          undefined,
          actor,
        ),
    );
    register(
      'evaluate_eligibility',
      '由后端规则核验资格；必须使用当前画像和岗位证据版本，结果不可改写。相同operationKey复用记录，版本过期返回冲突。',
      {
        ...EvaluateInputSchema.shape,
        operationKey: OperationKeySchema.describe('同一核验的稳定幂等键'),
      },
      (input, actor) => {
        const { operationKey, ...dto } = EvaluateInputSchema.extend({
          operationKey: OperationKeySchema,
        }).parse(input);
        return this.options.jobs.eligibility.create(
          EvaluateInputSchema.parse(dto),
          operationKey,
          actor,
        );
      },
    );
    register(
      'request_job_refresh',
      '登记岗位更新请求；异步排队，不代表已成功获取。相同操作键复用，已有活跃任务合并。',
      {
        jobId: z.uuid().describe('岗位ID'),
        operationKey: OperationKeySchema.describe('幂等键'),
      },
      (input, actor) =>
        this.options.ingestion.refresh.execute(
          z
            .object({ jobId: z.uuid(), operationKey: OperationKeySchema })
            .parse(input).jobId,
          z.object({ operationKey: OperationKeySchema }).parse(input)
            .operationKey,
          actor,
        ),
    );
    register(
      'get_task_status',
      '读取本人有权限的刷新任务状态；只读、可重复，未授权返回不存在。',
      { taskId: z.uuid().describe('实际任务ID') },
      (input, actor) =>
        this.options.ingestion.task.execute(
          z.object({ taskId: z.uuid() }).parse(input).taskId,
          actor,
        ),
    );
    register(
      'read_resume',
      '读取本人简历原文与页段定位；解析授权仅可读指定文件。文件未就绪409，已删或越权404；只读可重复。',
      {
        resumeId: z.uuid().describe('本人简历ID'),
        expectedVersion: z.number().int().positive().describe('原文版本'),
      },
      async (input, actor) => {
        const args = z
          .object({ resumeId: z.uuid(), expectedVersion: z.number() })
          .parse(input);
        const content = await this.options.resumes.resumes.content(
          args.resumeId,
          actor,
        );
        if (content.version !== args.expectedVersion)
          throw new Error('VERSION_CONFLICT');
        return content;
      },
    );
    register(
      'propose_profile_update',
      '创建待用户确认的画像草稿，禁止把假设写入正式画像；同operationKey幂等、异内容冲突。',
      ProposeProfileSchema.shape,
      (input, actor) => {
        const args = ProposeProfileSchema.parse(input);
        return this.options.resumes.resumes.createDraft(
          {
            content: args.content,
            baseProfileVersion: args.baseProfileVersion,
          },
          args.operationKey,
          actor,
        );
      },
    );
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  }
  @Get() async read(
    @Headers('authorization') auth: unknown,
    @Headers('x-run-grant') grant: unknown,
    @Res() response: Response,
  ) {
    serviceAuth(auth, this.options.serviceToken);
    await this.options.services.authorization.authorize(
      validated(z.string(), grant),
    );
    response.status(405).setHeader('Allow', 'POST');
    response.end();
  }
  @Delete() async remove(
    @Headers('authorization') auth: unknown,
    @Headers('x-run-grant') grant: unknown,
    @Res() response: Response,
  ) {
    return this.read(auth, grant, response);
  }
}
@Module({})
export class ChatHttpModule {
  static register(
    options: ChatHttpOptions,
    auth: DynamicModule,
  ): DynamicModule {
    return {
      module: ChatHttpModule,
      imports: [auth],
      controllers: [ChatController, AgentCallbackController, McpController],
      providers: [
        { provide: CHAT, useValue: options },
        BusinessExceptionFilter,
      ],
    };
  }
}
