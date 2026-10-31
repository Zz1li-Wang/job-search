import { Client } from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createIngestionRuntime,
  parseEvidenceHtml,
  type SourceReader,
  type IngestionServices,
  type IngestionDependencies,
} from '@career/business';
import { isolatedDatabaseUrl } from './database.js';
export function jobHtml(type = 'campus', revision = 'A') {
  return `<html><main><h1>测试岗位${revision}</h1><dl><dt>招聘类型</dt><dd>${type === 'campus' ? '校招' : '社招'}</dd><dt>招聘单位</dt><dd>虚构测试公司</dd><dt>报名状态</dt><dd>报名中</dd></dl><p>学历不限，经验未写明。</p></main></html>`;
}
export function fakeSource(): SourceReader {
  return {
    async list() {
      return {
        kind: 'list',
        jobIds: ['campus_fixture', 'social_fixture'],
        nextPage: null,
        fetchedAt: new Date(),
      };
    },
    async evidence(_kind, id) {
      return parseEvidenceHtml(
        jobHtml(id.startsWith('social') ? 'social' : 'campus'),
        new Date(),
      );
    },
  };
}
export interface IngestionFixture {
  services: IngestionServices;
  dependencies: IngestionDependencies;
  close(): Promise<void>;
}
export async function makeIngestionFixture(
  source: SourceReader = fakeSource(),
): Promise<IngestionFixture> {
  const client = new Client({ connectionString: isolatedDatabaseUrl() });
  await client.connect();
  try {
    await client.query(
      'TRUNCATE task_attempts, task_requesters, task_outbox, source_streams, source_resources, source_snapshots, source_request_budgets, domain_permits, export_runs CASCADE',
    );
    await client.query(
      "DELETE FROM idempotency_records WHERE scope LIKE 'operator:%' OR scope LIKE 'user:%:refresh' OR scope LIKE 'refresh-rate:%'",
    );
  } finally {
    await client.end();
  }
  const directory = await mkdtemp(join(tmpdir(), 'career-ingestion-'));
  const runtime = createIngestionRuntime(
    {
      databaseUrl: isolatedDatabaseUrl(),
      privateRoot: directory,
      exportRoot: join(directory, 'exports'),
      operatorReference: 'fixture_operator',
      network: { enabled: false, budgetId: randomUUID(), requestLimit: 0 },
    },
    { source },
  );
  return {
    services: runtime.services,
    dependencies: runtime.dependencies,
    async close() {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
