import { execFileSync } from 'node:child_process';

// テスト DB にマイグレーションを適用する（本番と同じ migrate deploy を使う）
export default function setup() {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DIRECT_URL:
        process.env.TEST_DATABASE_URL ??
        'postgresql://cradle:cradle@localhost:5432/cradle_test',
    },
  });
}
