import { loadConfig } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'x'.repeat(48),
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(base)).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      JWT_ACCESS_TTL_SECONDS: 900,
      CORS_ORIGINS: [],
      DB_POOL_MAX: 10,
      isVercel: false,
    });
    expect(loadConfig({ ...base, VERCEL: '1' })).toMatchObject({
      DB_POOL_MAX: 2,
      isVercel: true,
    });
  });

  it('reads the schema from DATABASE_URL and rejects unsafe names', () => {
    expect(loadConfig(base).dbSchema).toBe('public');
    expect(
      loadConfig({
        ...base,
        DATABASE_URL: `${base.DATABASE_URL}?schema=cradle-app`,
      }).dbSchema,
    ).toBe('cradle-app');
    expect(() =>
      loadConfig({ ...base, DATABASE_URL: `${base.DATABASE_URL}?schema=a"b` }),
    ).toThrow(/DATABASE_URL/);
  });

  it('reports only invalid keys, never values', () => {
    expect(() =>
      loadConfig({ ...base, JWT_ACCESS_SECRET: 'short-secret' }),
    ).toThrow(/^Invalid environment variables: JWT_ACCESS_SECRET$/);
  });

  it('rejects placeholder secrets in production or on Vercel', () => {
    const placeholder = {
      ...base,
      JWT_ACCESS_SECRET: 'local-dev-access-secret-change-me-0123456789',
    };
    expect(() => loadConfig(placeholder)).not.toThrow();
    expect(() =>
      loadConfig({ ...placeholder, NODE_ENV: 'production' }),
    ).toThrow(/placeholder/);
    expect(() => loadConfig({ ...placeholder, VERCEL: '1' })).toThrow(
      /placeholder/,
    );
  });

  it('enables mail when SMTP_URL, MAIL_FROM and APP_URL are all set', () => {
    const mail = {
      SMTP_URL: 'smtp://localhost:1025',
      MAIL_FROM: 'すくすく記録 <no-reply@example.com>',
      APP_URL: 'http://localhost:8080/',
    };
    expect(loadConfig(base).mail).toBeUndefined();
    // 一部だけの設定は設定漏れとして起動を止める
    expect(() => loadConfig({ ...base, SMTP_URL: mail.SMTP_URL })).toThrow(
      /must be set together/,
    );
    expect(() =>
      loadConfig({ ...base, ...mail, MAIL_FROM: 'not an address' }),
    ).toThrow(/MAIL_FROM/);
    expect(loadConfig({ ...base, ...mail }).mail).toEqual({
      smtpUrl: 'smtp://localhost:1025',
      from: mail.MAIL_FROM,
      appUrl: 'http://localhost:8080',
    });
  });

  it('requires https APP_URL in production', () => {
    const mail = {
      SMTP_URL: 'smtps://resend:key@smtp.resend.com:465',
      MAIL_FROM: 'a <a@example.com>',
      APP_URL: 'http://example.com',
    };
    expect(() =>
      loadConfig({ ...base, ...mail, NODE_ENV: 'production' }),
    ).toThrow(/APP_URL/);
    expect(
      loadConfig({
        ...base,
        ...mail,
        APP_URL: 'https://example.com',
        NODE_ENV: 'production',
      }).mail?.appUrl,
    ).toBe('https://example.com');
  });

  it('enables AI only with an API key and defaults to Claude Sonnet 5', () => {
    expect(loadConfig(base).ai).toBeUndefined();
    expect(loadConfig({ ...base, ANTHROPIC_API_KEY: 'k' }).ai).toEqual({
      apiKey: 'k',
      model: 'claude-sonnet-5',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(() => loadConfig({ ...base, CLAUDE_MODEL: 'gpt-5' })).toThrow(
      /CLAUDE_MODEL/,
    );
    expect(() => loadConfig({ ...base, CRON_SECRET: 'short' })).toThrow(
      /CRON_SECRET/,
    );
  });

  it('guards CRON_SECRET in production', () => {
    const prod = { ...base, NODE_ENV: 'production' };
    expect(() => loadConfig({ ...prod, ANTHROPIC_API_KEY: 'k' })).toThrow(
      /CRON_SECRET is required/,
    );
    expect(() =>
      loadConfig({
        ...prod,
        CRON_SECRET: 'test-cron-secret-0123456789-0123456789',
      }),
    ).toThrow(/CRON_SECRET must not be a placeholder/);
    const ok = { ...prod, ANTHROPIC_API_KEY: 'k', CRON_SECRET: 'x'.repeat(40) };
    expect(loadConfig(ok).ai).toBeDefined();
    // 本番では公式以外の接続先を拒否する（記録と API キーを別のホストに送らない）
    expect(() =>
      loadConfig({ ...ok, ANTHROPIC_BASE_URL: 'http://127.0.0.1:4010' }),
    ).toThrow(/ANTHROPIC_BASE_URL/);
  });
});
