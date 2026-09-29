import { z } from 'zod';

export const LLM_PROVIDERS = ['google', 'openai', 'anthropic'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

// LLM_MODEL を省略したときのモデル
const DEFAULT_LLM_MODELS: Record<LlmProvider, string> = {
  google: 'gemini-3.8-flash',
  openai: 'gpt-5.4-mini',
  anthropic: 'claude-sonnet-5',
};

const LLM_API_KEYS = {
  google: 'GOOGLE_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
} as const satisfies Record<LlmProvider, string>;

const emailFrom = z
  .string()
  .max(200)
  .regex(/^(?:[^<>\r\n]*<[^\s@<>]+@[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+)$/);

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
  // ---- メール（家族招待）。送信手段・差出人・APP_URL がそろったときだけ送れる ----
  // 送信手段: 本番は Resend（RESEND_API_KEY）。ローカルは SMTP_URL で Mailpit（外部に届かない）
  RESEND_API_KEY: z
    .string()
    .trim()
    .regex(/^re_[A-Za-z0-9_]{8,}$/)
    .optional(),
  SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
  // 差出人。例: すくすく記録 <no-reply@example.com>
  EMAIL_FROM: emailFrom.optional(),
  // 旧名（互換のため EMAIL_FROM がないときだけ読む。形式の検証もそのときに行う）
  MAIL_FROM: z.string().optional(),
  // 招待リンクの起点（Web の公開 URL）。例: http://localhost:8080 / https://<domain>
  APP_URL: z
    .url({ protocol: /^https?$/ })
    .transform((v) => v.replace(/\/+$/, ''))
    .optional(),
  // ---- AI（食事の提案・習慣レポート）。選んだプロバイダの API キーがあるときだけ有効 ----
  // 切り替えは LLM_PROVIDER / LLM_MODEL だけで行う。キーは各 SDK の標準の変数名
  LLM_PROVIDER: z.enum(LLM_PROVIDERS).optional(),
  LLM_MODEL: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/)
    .optional(),
  GOOGLE_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().trim().min(1).optional(),
  // 定期実行（Vercel Cron）の認証。Vercel は `Authorization: Bearer <CRON_SECRET>` を付けて呼ぶ。未設定なら Cron は無効
  CRON_SECRET: z.string().trim().min(32).optional(),
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
  /** メール送信の設定。未設定なら招待メールは送れない */
  mail?: { transport: MailTransport; from: string; appUrl: string };
  /** AI の設定。未設定なら AI 機能は使えない（503） */
  ai?: AiConfig;
};

export interface AiConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
}

/** 送信手段。RESEND_API_KEY があれば Resend、なければ SMTP（ローカルの Mailpit） */
export type MailTransport =
  { type: 'resend'; apiKey: string } | { type: 'smtp'; url: string };

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
  const { RESEND_API_KEY, SMTP_URL, APP_URL } = config;
  const deployed = config.NODE_ENV === 'production' || isVercel;
  let from = config.EMAIL_FROM;
  if (!from && config.MAIL_FROM) {
    if (!emailFrom.safeParse(config.MAIL_FROM).success) {
      throw new Error('Invalid environment variables: MAIL_FROM');
    }
    from = config.MAIL_FROM;
  }
  if (RESEND_API_KEY && SMTP_URL && !deployed) {
    // ローカルに本物のキーを置いたまま Mailpit のつもりで試し、実際にメールが送られるのを防ぐ
    throw new Error(
      'Invalid environment variables: set either RESEND_API_KEY or SMTP_URL, not both',
    );
  }
  if (SMTP_URL && deployed && !SMTP_URL.startsWith('smtps://')) {
    // 本番で認証情報・招待コードを暗号化なしで送らない
    throw new Error('Invalid environment variables: SMTP_URL (smtps required)');
  }
  const transport: MailTransport | undefined = RESEND_API_KEY
    ? { type: 'resend', apiKey: RESEND_API_KEY }
    : SMTP_URL
      ? { type: 'smtp', url: SMTP_URL }
      : undefined;
  const mailKeys = [transport, from, APP_URL].filter(Boolean).length;
  // 一部だけ設定されているのは設定漏れなので、黙って無効にせず起動を止める
  if (mailKeys > 0 && mailKeys < 3) {
    throw new Error(
      'Invalid environment variables: RESEND_API_KEY (or SMTP_URL), EMAIL_FROM and APP_URL must be set together',
    );
  }
  if (transport && from && APP_URL) {
    // 招待リンクを平文 HTTP で配らない（ローカル以外）
    if (deployed && !APP_URL.startsWith('https://')) {
      throw new Error(
        'Invalid environment variables: APP_URL (https required)',
      );
    }
    config.mail = { transport, from, appUrl: APP_URL };
  }
  config.ai = loadAiConfig(config);
  if (
    config.CRON_SECRET &&
    deployed &&
    PLACEHOLDER_SECRET.test(config.CRON_SECRET)
  ) {
    throw new Error('CRON_SECRET must not be a placeholder value');
  }
  return config;
}

function loadAiConfig(config: AppConfig): AiConfig | undefined {
  const provider = config.LLM_PROVIDER ?? 'google';
  const apiKey = config[LLM_API_KEYS[provider]];
  if (!apiKey) {
    // プロバイダやモデルを指定したのにキーがない、または別のプロバイダのキーだけがあるのは設定漏れなので、
    // 黙って無効にせず起動を止める
    const otherKey = Object.values(LLM_API_KEYS).some((k) => config[k]);
    if (config.LLM_PROVIDER || config.LLM_MODEL || otherKey) {
      throw new Error(
        `Invalid environment variables: ${LLM_API_KEYS[provider]} is required for LLM_PROVIDER=${provider}`,
      );
    }
    return undefined;
  }
  return {
    provider,
    model: config.LLM_MODEL ?? DEFAULT_LLM_MODELS[provider],
    apiKey,
  };
}
