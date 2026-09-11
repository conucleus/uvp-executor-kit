import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // vitest 无法收集 node:test 套件（收集期报 "No test suite found"）：
    // *.node.test.ts 由 tsx --test 在 pnpm test 的第二步执行。
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/**/*.node.test.ts'],
  },
});
