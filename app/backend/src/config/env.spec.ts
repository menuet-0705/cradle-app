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
});
