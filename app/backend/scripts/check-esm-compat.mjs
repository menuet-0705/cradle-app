// Vercel の実行環境は「CommonJS から ESM を require する」読み込み（require(esm)）に対応していない。
// 手元の Node では動いてしまうため、ビルド時にその機能を無効にしてアプリを初期化し、依存に問題がないか確認する。
// import だけでなく app.init() まで行い、起動時に遅延読み込みされるパッケージも対象にする（DB には接続しない）。
import { execFileSync } from 'node:child_process';

const script = `
  const { createApp } = await import('./dist/app.factory.js');
  await import('./dist/serverless.js');
  const app = await createApp();
  await app.init();
  await app.close();
`;

try {
  execFileSync(
    process.execPath,
    ['--no-experimental-require-module', '--input-type=module', '-e', script],
    {
      stdio: 'pipe',
      // 終了しない場合にビルドを止めたままにしない
      timeout: 60_000,
      // 検査専用のダミー値（接続はしない）。実際の環境変数は使わない
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://check:check@127.0.0.1:1/check',
        JWT_ACCESS_SECRET: 'esm-compat-check-secret-0123456789abcdef',
      },
    },
  );
  console.log('ESM compatibility check passed');
} catch (e) {
  const stderr = String(e.stderr ?? e.message);
  if (/ERR_REQUIRE_ESM|ERR_REQUIRE_ASYNC_MODULE/.test(stderr)) {
    console.error(stderr);
    console.error(
      'error: a CommonJS dependency requires an ESM-only package. This fails on Vercel (no require(esm) support).',
    );
  } else {
    console.error(stderr);
    console.error(
      'error: the ESM compatibility check could not start the app (see above).',
    );
  }
  process.exit(1);
}
