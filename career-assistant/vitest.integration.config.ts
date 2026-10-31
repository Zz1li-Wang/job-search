import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';
export default defineConfig({
  ...base,
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 20000,
    fileParallelism: false,
  },
});
