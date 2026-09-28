import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// マイグレーションはプーラーを経由しない直接接続（DIRECT_URL）で実行する。
// `prisma generate` は接続不要なので、DIRECT_URL がないビルド環境（CI / Vercel）でも動くようにしておく
const url = process.env.DIRECT_URL;

// マイグレーション（DIRECT_URL）と実行時（DATABASE_URL）でスキーマが食い違うと、実行時にテーブルが見つからない
const schemaOf = (u?: string) => {
  if (!u) return undefined;
  try {
    return new URL(u).searchParams.get('schema') ?? 'public';
  } catch {
    // URL 解析エラーには接続文字列（パスワード含む）が載るので、そのまま投げない
    throw new Error('DIRECT_URL / DATABASE_URL is not a valid URL');
  }
};
const runtimeUrl = process.env.DATABASE_URL;
if (url && runtimeUrl && schemaOf(url) !== schemaOf(runtimeUrl)) {
  throw new Error('DIRECT_URL and DATABASE_URL must use the same ?schema=');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  ...(url && { datasource: { url } }),
});
