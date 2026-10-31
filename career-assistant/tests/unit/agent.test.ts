import { it, expect } from 'vitest';
import { streamModel, AgentFailure } from '@career/agent-core';
import { EXECUTION_POLICY } from '@career/contracts';
const config = {
  MODEL_BASE_URL: 'http://127.0.0.1',
  MODEL_API_KEY: 'local-fixture',
  MODEL_NAME: 'deepseek-v4-pro' as const,
};
const response = (text: string) => async () =>
  new Response(
    new ReadableStream({
      start(controller) {
        const bytes = new TextEncoder().encode(text);
        for (let i = 0; i < bytes.length; i += 7)
          controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
it('模型SSE跨网络块和中文字符分割保留文本与工具参数', async () => {
  const events = [
    { choices: [{ delta: { content: '你好' } }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'tool-1',
                function: { name: 'get_', arguments: '{' },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { name: 'profile', arguments: '}' } },
            ],
          },
        },
      ],
    },
  ];
  const text =
    events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('') +
    'data: [DONE]\n\n';
  let partial = '';
  const result = await streamModel(
    config,
    [{ role: 'user', content: '测试' }],
    [],
    new AbortController().signal,
    async (delta) => {
      partial += delta;
    },
    response(text),
  );
  expect(partial).toBe('你好');
  expect(result.calls[0]?.function).toEqual({
    name: 'get_profile',
    arguments: '{}',
  });
});
it('模型异常与断流不能伪装完成', async () => {
  await expect(
    streamModel(
      config,
      [{ role: 'user', content: '测试' }],
      [],
      new AbortController().signal,
      async () => {},
      response('data: {"choices":[{"delta":{"content":"中断"}}]}\n\n'),
    ),
  ).rejects.toMatchObject({ code: 'MODEL_INTERRUPTED' });
  await expect(
    streamModel(
      config,
      [{ role: 'user', content: '测试' }],
      [],
      new AbortController().signal,
      async () => {},
      async () => new Response('unavailable', { status: 503 }),
    ),
  ).rejects.toBeInstanceOf(AgentFailure);
});

it('上下文超限使用独立错误码且不发送模型请求', async () => {
  let requests = 0;
  await expect(
    streamModel(
      config,
      [
        {
          role: 'user',
          content: '长'.repeat(EXECUTION_POLICY.modelInputCharacters),
        },
      ],
      [],
      new AbortController().signal,
      async () => {},
      async () => {
        requests++;
        return new Response();
      },
    ),
  ).rejects.toMatchObject({ code: 'MODEL_CONTEXT_EXCEEDED' });
  expect(requests).toBe(0);
});
