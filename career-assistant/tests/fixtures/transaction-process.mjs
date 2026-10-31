import { IdempotencyRecord, createPersistence } from '@career/business';

if (
  process.env.TEST_DATABASE_ISOLATED !== 'true' ||
  new URL(process.env.DATABASE_URL).pathname !== '/career_test'
)
  throw Error('仅允许隔离测试数据库');
const persistence = createPersistence(process.env.DATABASE_URL);
const [operation, key] = process.argv.slice(2);
try {
  if (operation === 'read') {
    const record = await persistence.unitOfWork.run((tx) =>
      persistence.records(tx).getRecord('process-fixture', key),
    );
    console.log(
      JSON.stringify({
        responseReference: record?.snapshot().responseReference ?? null,
      }),
    );
  } else if (operation === 'write' || operation === 'rollback') {
    try {
      await persistence.unitOfWork.run(async (tx) => {
        await persistence.records(tx).insertIfAbsent(
          new IdempotencyRecord({
            scope: 'process-fixture',
            key,
            requestHash: 'c'.repeat(64),
            responseReference: 'persisted-across-processes',
            createdAt: new Date(),
          }),
        );
        if (operation === 'rollback') throw Error('expected-rollback');
      });
      console.log(JSON.stringify({ committed: true }));
    } catch (error) {
      if (operation !== 'rollback' || error.message !== 'expected-rollback')
        throw error;
      console.log(JSON.stringify({ rolledBack: true }));
    }
  } else throw Error('非法夹具操作');
} finally {
  await persistence.close();
}
