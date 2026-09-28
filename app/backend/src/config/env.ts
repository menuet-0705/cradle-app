import { z } from 'zod';

// 環境差異は全てここに集約する。ローカル/検証/本番でコードは同一、値だけが違う。
const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  // Vercel が自動で設定する。サーバーレス実行時の既定値の切り替えに使う
  VERCEL: z.string().optional(),
  // 省略時: Vercel 上は 2（同一インスタンスでの同時実行に備えて少しだけ余裕を持たせる）、それ以外は 10
  DB_POOL_MAX: z.coerce.number().int().positive().optional(),
  JWT_ACCESS_SECRET: z.string().min(32),
  // アクセストークンはログアウトで失効できないので短く保つ
  JWT_ACCESS_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(3600)
    .default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});

export type AppConfig = Omit<z.infer<typeof envSchema>, 'DB_POOL_MAX'> & {
  DB_POOL_MAX: number;
  isVercel: boolean;
  /** DATABASE_URL の `?schema=` で指定したスキーマ（既定 public） */
  dbSchema: string;
};

// 生 SQL に埋め込むため、識別子として安全な文字だけを許可する
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/;

// .env.example やテストの値を本番に流用させない
const PLACEHOLDER_SECRET = /change-me|local-dev|test-/i;

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // 値そのものは出さず、どのキーが不正かだけを出す
    const keys = result.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment variables: ${keys}`);
  }
  const isVercel = Boolean(result.data.VERCEL);
  const dbSchema =
    new URL(result.data.DATABASE_URL).searchParams.get('schema') ?? 'public';
  if (!SCHEMA_NAME.test(dbSchema)) {
    throw new Error('Invalid environment variables: DATABASE_URL (schema)');
  }
  const config: AppConfig = {
    ...result.data,
    isVercel,
    dbSchema,
    DB_POOL_MAX: result.data.DB_POOL_MAX ?? (isVercel ? 2 : 10),
  };
  if (
    // Preview デプロイで NODE_ENV が未設定でも検知できるよう Vercel 上かも見る
    (config.NODE_ENV === 'production' || isVercel) &&
    PLACEHOLDER_SECRET.test(config.JWT_ACCESS_SECRET)
  ) {
    throw new Error('JWT_ACCESS_SECRET must not be a placeholder value');
  }
  return config;
}
