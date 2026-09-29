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

  it('uses Resend when RESEND_API_KEY is set (production)', () => {
    const mail = {
      RESEND_API_KEY: 're_test_key',
      EMAIL_FROM: 'すくすく記録 <no-reply@example.com>',
      APP_URL: 'https://example.com/',
    };
    expect(loadConfig({ ...base, ...mail }).mail).toEqual({
      transport: { type: 'resend', apiKey: 're_test_key' },
      from: mail.EMAIL_FROM,
      appUrl: 'https://example.com',
    });
    // Resend のキーの形式でなければ拒否
    for (const key of ['sk-xxx', 're_', 're_short']) {
      expect(() =>
        loadConfig({ ...base, ...mail, RESEND_API_KEY: key }),
      ).toThrow(/RESEND_API_KEY/);
    }
    // ローカルで両方あると、Mailpit のつもりで実際に送ってしまうので拒否
    expect(() =>
      loadConfig({ ...base, ...mail, SMTP_URL: 'smtp://localhost:1025' }),
    ).toThrow(/not both/);
    // 本番では Resend を優先（旧設定の SMTP_URL が残っていても動く）
    expect(
      loadConfig({
        ...base,
        ...mail,
        NODE_ENV: 'production',
        SMTP_URL: 'smtps://resend:x@smtp.resend.com:465',
      }).mail?.transport.type,
    ).toBe('resend');
  });

  it('requires smtps for SMTP in production', () => {
    const mail = {
      EMAIL_FROM: 'a <a@example.com>',
      APP_URL: 'https://example.com',
      NODE_ENV: 'production',
    };
    expect(() =>
      loadConfig({ ...base, ...mail, SMTP_URL: 'smtp://mail.example.com' }),
    ).toThrow(/smtps required/);
  });

  it('uses SMTP (Mailpit) when only SMTP_URL is set (local)', () => {
    const mail = {
      SMTP_URL: 'smtp://localhost:1025',
      EMAIL_FROM: 'すくすく記録 <no-reply@example.com>',
      APP_URL: 'http://localhost:8080/',
    };
    expect(loadConfig(base).mail).toBeUndefined();
    expect(loadConfig({ ...base, ...mail }).mail).toEqual({
      transport: { type: 'smtp', url: 'smtp://localhost:1025' },
      from: mail.EMAIL_FROM,
      appUrl: 'http://localhost:8080',
    });
    // 旧名の MAIL_FROM も読む（既存の .env の互換）
    const { EMAIL_FROM: _omit, ...legacy } = mail;
    expect(
      loadConfig({ ...base, ...legacy, MAIL_FROM: mail.EMAIL_FROM }).mail?.from,
    ).toBe(mail.EMAIL_FROM);
  });

  it('rejects partial or invalid mail settings', () => {
    const key = 're_abcdefgh123';
    // 一部だけの設定は設定漏れとして起動を止める
    expect(() => loadConfig({ ...base, RESEND_API_KEY: key })).toThrow(
      /must be set together/,
    );
    expect(() =>
      loadConfig({
        ...base,
        RESEND_API_KEY: key,
        APP_URL: 'https://example.com',
        EMAIL_FROM: 'not an address',
      }),
    ).toThrow(/EMAIL_FROM/);
    // 旧名の MAIL_FROM は EMAIL_FROM があれば無視する（形式が古くても起動を止めない）
    expect(
      loadConfig({
        ...base,
        RESEND_API_KEY: key,
        APP_URL: 'https://example.com',
        EMAIL_FROM: 'a <a@example.com>',
        MAIL_FROM: 'broken',
      }).mail?.from,
    ).toBe('a <a@example.com>');
  });

  it('requires https APP_URL in production', () => {
    const mail = {
      RESEND_API_KEY: 're_test_key',
      EMAIL_FROM: 'a <a@example.com>',
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

  describe('AI', () => {
    it('is disabled when no API key is set', () => {
      expect(loadConfig(base).ai).toBeUndefined();
    });

    it('defaults to Gemini when GOOGLE_API_KEY is set', () => {
      expect(loadConfig({ ...base, GOOGLE_API_KEY: 'g-key' }).ai).toEqual({
        provider: 'google',
        model: 'gemini-3.7-flash',
        apiKey: 'g-key',
      });
    });

    it('switches the provider and model by environment variables only', () => {
      expect(
        loadConfig({
          ...base,
          LLM_PROVIDER: 'anthropic',
          LLM_MODEL: 'claude-haiku-4-5',
          ANTHROPIC_API_KEY: 'a-key',
          GOOGLE_API_KEY: 'g-key',
        }).ai,
      ).toEqual({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        apiKey: 'a-key',
      });
      expect(
        loadConfig({ ...base, LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'o' }).ai,
      ).toMatchObject({ provider: 'openai', apiKey: 'o' });
    });

    it('fails to start when the chosen provider has no API key', () => {
      expect(() =>
        loadConfig({ ...base, LLM_PROVIDER: 'openai', GOOGLE_API_KEY: 'g' }),
      ).toThrow(/OPENAI_API_KEY/);
      expect(() => loadConfig({ ...base, LLM_MODEL: 'gemini-x' })).toThrow(
        /GOOGLE_API_KEY/,
      );
      // 別のプロバイダのキーだけがある（LLM_PROVIDER の設定漏れ）
      expect(() => loadConfig({ ...base, OPENAI_API_KEY: 'o' })).toThrow(
        /GOOGLE_API_KEY is required for LLM_PROVIDER=google/,
      );
    });

    it('rejects unknown providers and never echoes key values', () => {
      expect(() =>
        loadConfig({ ...base, LLM_PROVIDER: 'mistral', GOOGLE_API_KEY: 'g' }),
      ).toThrow(/^Invalid environment variables: LLM_PROVIDER$/);
      expect(() =>
        loadConfig({
          ...base,
          LLM_PROVIDER: 'openai',
          LLM_MODEL: 'bad model!',
          OPENAI_API_KEY: 'sk-secret-value',
        }),
      ).toThrow(/^Invalid environment variables: LLM_MODEL$/);
    });
  });

  describe('CRON_SECRET', () => {
    it('requires 32+ characters and rejects placeholders when deployed', () => {
      expect(() => loadConfig({ ...base, CRON_SECRET: 'short' })).toThrow(
        /CRON_SECRET/,
      );
      const placeholder = {
        ...base,
        CRON_SECRET: `change-me-${'x'.repeat(32)}`,
      };
      expect(() => loadConfig(placeholder)).not.toThrow();
      expect(() => loadConfig({ ...placeholder, VERCEL: '1' })).toThrow(
        /CRON_SECRET/,
      );
    });
  });
});
