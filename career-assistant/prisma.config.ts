import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'packages/business/prisma/schema.prisma',
  migrations: { path: 'packages/business/prisma/migrations' },
  datasource: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://unused:unused@127.0.0.1:1/unused',
  },
});
