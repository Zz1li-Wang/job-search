/** 所有数据库测试只允许独立临时career_test库。 */
export function isolatedDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (
    process.env.TEST_DATABASE_ISOLATED !== 'true' ||
    !url ||
    new URL(url).pathname !== '/career_test'
  )
    throw Error('测试只能使用隔离数据库');
  return url;
}
