import { execFileSync } from 'node:child_process';

// テスト DB にマイグレーションを適用する（本番と同じ migrate deploy を使う）
export default function setup() {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgresql://cradle:cradle@localhost:5432/cradle_test';
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    // .env の接続先（検証/本番の可能性がある）を使わないよう両方とも明示する
    env: { ...process.env, DIRECT_URL: url, DATABASE_URL: url },
  });
}
