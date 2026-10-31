import { emptyProfileContent } from '@career/contracts';
import { createServer } from 'node:http';
export async function startModelFixture() {
  let calls = 0;
  let mode:
    | 'normal'
    | 'broken'
    | 'unknown_tool'
    | 'invalid_dates'
    | 'dated_resume'
    | 'dated_parent'
    | 'paraphrased_description'
    | 'fabricated_description'
    | 'http_error' = 'normal';
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const input = JSON.parse(body) as {
      messages: { role: string; content: string }[];
    };
    calls++;
    if (mode === 'http_error') {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          error: { message: 'provider-private-fixture-detail' },
        }),
      );
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta: unknown) =>
      response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    if (mode === 'broken') {
      emit({ content: '尚未完成的回答' });
      response.end();
      return;
    }
    if (mode === 'unknown_tool') {
      emit({
        tool_calls: [
          {
            index: 0,
            id: 'forbidden',
            function: { name: 'delete_private_data', arguments: '{}' },
          },
        ],
      });
      response.end('data: [DONE]\n\n');
      return;
    }
    if (
      input.messages.some(
        (m) => m.role === 'system' && m.content.includes('画像结构化'),
      )
    ) {
      if (
        mode === 'paraphrased_description' ||
        mode === 'fabricated_description'
      ) {
        emit({
          content: JSON.stringify({
            content: {
              ...emptyProfileContent(),
              internshipEntries: [
                {
                  organization: null,
                  role: null,
                  startDate: { value: null, precision: 'unknown' },
                  endDate: { value: null, precision: 'unknown' },
                  isCurrent: false,
                  description: '模型概括的经历说明',
                },
              ],
            },
            evidence: [
              {
                path: '/internshipEntries/0/description',
                locator: 'paragraph:1',
                excerpt:
                  mode === 'paraphrased_description'
                    ? '原文项目实践'
                    : '原文中不存在的内容',
              },
            ],
          }),
        });
      } else {
        const hasDate =
          mode === 'invalid_dates' ||
          mode === 'dated_resume' ||
          mode === 'dated_parent';
        emit({
          content: JSON.stringify(
            hasDate
              ? {
                  content: {
                    ...emptyProfileContent(),
                    educationEntries: [
                      {
                        school: null,
                        major: null,
                        degree: null,
                        awardStatus: 'unknown',
                        graduationDate: {
                          value:
                            mode === 'invalid_dates' ? '2027.06' : '2027-06',
                          precision: 'month',
                        },
                        dateKind: 'unknown',
                      },
                    ],
                  },
                  evidence: [
                    {
                      path:
                        mode === 'dated_parent'
                          ? '/educationEntries/0/graduationDate'
                          : '/educationEntries/0/graduationDate/value',
                      locator: 'paragraph:1',
                      excerpt: '2027.06',
                    },
                  ],
                }
              : {
                  content: { ...emptyProfileContent(), skills: ['TypeScript'] },
                  evidence: [
                    {
                      path: '/skills/0',
                      locator: 'paragraph:1',
                      excerpt: 'TypeScript',
                    },
                  ],
                },
          ),
        });
      }
    } else if (!input.messages.some((m) => m.role === 'tool')) {
      emit({
        tool_calls: [
          {
            index: 0,
            id: 'profile-call',
            function: { name: 'get_profile', arguments: '{}' },
          },
        ],
      });
    } else {
      emit({ content: '请先梳理你的求职方向。' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      emit({ content: '尚未确认的资料需要你核对。' });
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error();
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls: () => calls,
    setMode: (next: typeof mode) => {
      mode = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
