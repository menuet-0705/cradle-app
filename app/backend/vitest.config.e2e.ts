import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// e2e は docker compose の Postgres 上の専用 DB（cradle_test）を使い、開発データと分離する
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://cradle:cradle@localhost:5432/cradle_test';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      DIRECT_URL: TEST_DATABASE_URL,
      JWT_ACCESS_SECRET: 'test-access-secret-0123456789-0123456789',
    },
  },
});
