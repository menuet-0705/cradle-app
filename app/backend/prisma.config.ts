import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// マイグレーションはプーラーを経由しない直接接続（DIRECT_URL）で実行する。
// `prisma generate` は接続不要なので、DIRECT_URL がないビルド環境（CI / Vercel）でも動くようにしておく
const url = process.env.DIRECT_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  ...(url && { datasource: { url } }),
});
