import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { emptyProfileContent, DateFactSchema } from '@career/contracts';
import {
  extractDocument,
  validateExtraction,
  ProfileDraftEntity,
} from '@career/business';
it('简历本地提取保留段落并拒绝编码伪装与扫描件', async () => {
  expect(await extractDocument(Buffer.from('TypeScript\nSQL'), 'txt')).toEqual([
    { locator: 'paragraph:1', text: 'TypeScript' },
    { locator: 'paragraph:2', text: 'SQL' },
  ]);
  await expect(
    extractDocument(Buffer.from([255, 254]), 'txt'),
  ).rejects.toMatchObject({ code: 'FILE_INVALID' });
  await expect(
    extractDocument(Buffer.from('not-pdf'), 'pdf'),
  ).rejects.toMatchObject({ code: 'FILE_INVALID' });
  await expect(extractDocument(Buffer.from('  '), 'txt')).rejects.toMatchObject(
    { code: 'FILE_NO_TEXT' },
  );
  await expect(
    extractDocument(Buffer.alloc(10 * 1024 * 1024 + 1), 'txt'),
  ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
});
it('模型画像逐字段证据不可捏造或声称完整', () => {
  const content = { ...emptyProfileContent(), skills: ['TypeScript'] },
    spans = [{ locator: 'paragraph:1', text: '熟悉TypeScript' }];
  expect(() =>
    validateExtraction(
      content,
      [{ path: '/skills/0', locator: 'paragraph:1', excerpt: 'TypeScript' }],
      spans,
    ),
  ).not.toThrow();
  expect(() => validateExtraction(content, [], spans)).toThrow();
  expect(() =>
    validateExtraction(
      { ...content, skills: ['Python'] },
      [{ path: '/skills/0', locator: 'paragraph:1', excerpt: 'TypeScript' }],
      spans,
    ),
  ).toThrow();
  expect(() =>
    validateExtraction(
      { ...emptyProfileContent(), employmentCompleteness: 'complete' },
      [],
      spans,
    ),
  ).toThrow();
});
it('草稿确认拒绝未来生日和过时版本', () => {
  const draft = new ProfileDraftEntity({
    id: randomUUID(),
    userId: randomUUID(),
    version: 1,
    baseProfileVersion: 0,
    content: {
      ...emptyProfileContent(),
      birthDate: { value: '2099', precision: 'year' },
    },
    status: 'draft',
    sourceResumeId: null,
    sourceResumeVersion: null,
    evidence: [],
    confirmedProfileVersion: null,
    confirmedContent: null,
    confirmedAt: null,
    createdAt: new Date(),
  });
  expect(() => draft.confirm(1, 0, 0, new Date('2026-10-31'))).toThrow();
  expect(() => draft.confirm(1, 0, 1, new Date('2026-10-31'))).toThrow();
});

it('明确的当前在岗事实可以作为带证据草稿提取', () => {
  const content = {
    ...emptyProfileContent(),
    formalEmploymentEntries: [
      {
        organization: null,
        role: null,
        startDate: { value: null, precision: 'unknown' as const },
        endDate: { value: null, precision: 'unknown' as const },
        isCurrent: true,
        description: '',
      },
    ],
  };
  expect(() =>
    validateExtraction(
      content,
      [
        {
          path: '/formalEmploymentEntries/0/isCurrent',
          locator: 'paragraph:1',
          excerpt: '至今',
        },
      ],
      [{ locator: 'paragraph:1', text: '在岗，至今' }],
    ),
  ).not.toThrow();
  expect(() =>
    validateExtraction(
      content,
      [],
      [{ locator: 'paragraph:1', text: '在岗，至今' }],
    ),
  ).toThrow();
});

it('正式文档适配器提取有效PDF与DOCX并拒绝无文字PDF', async () => {
  const { fictionalPdf, fictionalDocx } = await import('@career/testing');
  const pdf = await extractDocument(fictionalPdf(), 'pdf'),
    docx = await extractDocument(fictionalDocx('TypeScript 中文简历'), 'docx');
  expect(pdf).toEqual([{ locator: 'page:1', text: 'TypeScript' }]);
  expect(docx).toEqual([
    { locator: 'paragraph:1', text: 'TypeScript 中文简历' },
  ]);
  await expect(extractDocument(fictionalPdf(''), 'pdf')).rejects.toMatchObject({
    code: 'FILE_NO_TEXT',
  });
});

it('日期格式规范不放宽日历或精度规则，也不补齐未知月日', () => {
  for (const fact of [
    { value: '2027', precision: 'year' },
    { value: '2027-06', precision: 'month' },
    { value: '2024-02-29', precision: 'day' },
    { value: null, precision: 'unknown' },
  ])
    expect(DateFactSchema.parse(fact)).toEqual(fact);
  for (const fact of [
    { value: '2027.06', precision: 'month' },
    { value: '2027-06-01', precision: 'month' },
    { value: '2027-13', precision: 'month' },
    { value: '2027-02-29', precision: 'day' },
    { value: '2027', precision: 'unknown' },
  ])
    expect(DateFactSchema.safeParse(fact).success).toBe(false);
});

it('日期对象证据转值定位且明确字段引用优先，仍须通过原文核验', async () => {
  const { normalizeExtractionEvidence } = await import('@career/agent-core');
  const extracted = {
    content: {
      ...emptyProfileContent(),
      educationEntries: [
        {
          school: null,
          major: null,
          degree: null,
          awardStatus: 'unknown' as const,
          graduationDate: { value: '2027-06', precision: 'month' as const },
          dateKind: 'unknown' as const,
        },
      ],
    },
    evidence: [
      {
        path: '/educationEntries/0/graduationDate',
        locator: 'paragraph:1',
        excerpt: '2027.06',
      },
    ],
  };
  const normalized = normalizeExtractionEvidence(extracted);
  expect(normalized.evidence[0]?.path).toBe(
    '/educationEntries/0/graduationDate/value',
  );
  const spans = [{ locator: 'paragraph:1', text: '2027.06' }];
  expect(() =>
    validateExtraction(normalized.content, normalized.evidence, spans),
  ).not.toThrow();
  expect(() =>
    validateExtraction(normalized.content, normalized.evidence, [
      { locator: 'paragraph:1', text: '2027.07' },
    ]),
  ).toThrow();
  const explicit = normalizeExtractionEvidence({
    ...extracted,
    evidence: [
      ...extracted.evidence,
      {
        path: '/educationEntries/0/graduationDate/value',
        locator: 'paragraph:2',
        excerpt: '2027.07',
      },
    ],
  });
  expect(explicit.evidence).toEqual([
    {
      path: '/educationEntries/0/graduationDate/value',
      locator: 'paragraph:2',
      excerpt: '2027.07',
    },
  ]);
  expect(() =>
    validateExtraction(explicit.content, explicit.evidence, [
      ...spans,
      { locator: 'paragraph:2', text: '2027.07' },
    ]),
  ).toThrow();
  expect(() => validateExtraction(normalized.content, [], spans)).toThrowError(
    expect.objectContaining({
      code: 'INVALID_EVIDENCE',
      fieldPath: '/educationEntries/0/graduationDate/value',
      reason: 'missing_reference',
    }),
  );
});

it('内部提取失败只信任受限错误信封，未知或畸形响应保持结果未知', async () => {
  const { createServer } = await import('node:http');
  const { createExtractionClient } = await import('@career/business');
  let payload = '';
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(502, { 'Content-Type': 'application/json' });
    response.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw Error('测试服务器地址不可用');
  const extract = createExtractionClient(
    `http://127.0.0.1:${address.port}`,
    'local-service-fixture',
  );
  const input = {
    runId: randomUUID(),
    resumeId: randomUUID(),
    version: 1,
    grant: 'local-grant-fixture',
  };
  try {
    for (const body of [
      'invalid-json',
      JSON.stringify({
        requestId: randomUUID(),
        error: {
          code: 'UNRECOGNIZED_FAILURE',
          message: 'provider-private-fixture-detail',
        },
      }),
      JSON.stringify({
        error: { code: 'MODEL_OUTPUT_INVALID', message: 'missing-request-id' },
      }),
    ]) {
      payload = body;
      await expect(extract(input)).rejects.toMatchObject({
        code: 'MODEL_INTERRUPTED',
      });
    }
    payload = JSON.stringify({
      requestId: randomUUID(),
      error: {
        code: 'MODEL_OUTPUT_INVALID',
        message: 'provider-private-fixture-detail',
      },
    });
    await expect(extract(input)).rejects.toMatchObject({
      code: 'MODEL_OUTPUT_INVALID',
      message: '模型返回的结构或字段格式无效，请核对资料或显式重试',
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
