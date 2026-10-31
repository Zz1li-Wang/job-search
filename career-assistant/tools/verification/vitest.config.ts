import { defineConfig } from "vitest/config";

/** 保持历史验证工具独立，避免继承正式workspace的测试入口。 */
export default defineConfig({ test: { include: ["*.test.ts"] } });
