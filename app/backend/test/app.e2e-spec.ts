import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { configureApp } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('cradle API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let throttler = new ThrottlerStorageService();
  const throttlerStorage: ThrottlerStorage = {
    increment: (...args) => throttler.increment(...args),
  };

  const api = () => request(app.getHttpServer());
  let seq = 0;
  const signup = async (name = 'テスト') => {
    const email = `user${Date.now()}-${seq++}@example.com`;
    const res = await api()
      .post('/api/v1/auth/signup')
      .send({ email, password: 'password123', name })
      .expect(201);
    return { email, ...(res.body as Tokens) };
  };
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ThrottlerStorage)
      .useValue(throttlerStorage)
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
    // 設定ミスで開発・本番のデータを消さないよう、テスト用 DB であることを確認してから消す
    const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`
      SELECT current_database() AS db`;
    if (!db.endsWith('_test')) throw new Error(`Refusing to wipe ${db}`);
    await prisma.user.deleteMany();
    await prisma.family.deleteMany();
  });

  // 認証 API のレート制限（1分10回）にテスト自体が引っかからないよう、テストごとに作り直す
  beforeEach(() => {
    throttler.onApplicationShutdown();
    throttler = new ThrottlerStorageService();
  });

  afterAll(async () => {
    throttler.onApplicationShutdown();
    await app.close();
  });

  describe('auth', () => {
    it('signs up, logs in and returns me', async () => {
      const { email, accessToken } = await signup('ママ');
      const me = await api().get('/api/v1/me').set(auth(accessToken));
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ email, name: 'ママ' });
      expect(me.body).not.toHaveProperty('passwordHash');

      await api()
        .post('/api/v1/auth/login')
        .send({ email: email.toUpperCase(), password: 'password123' })
        .expect(200);
    });

    it('rejects duplicate email and wrong password', async () => {
      const { email } = await signup();
      await api()
        .post('/api/v1/auth/signup')
        .send({ email, password: 'password123', name: 'x' })
        .expect(409);
      await api()
        .post('/api/v1/auth/login')
        .send({ email, password: 'wrong-password' })
        .expect(401);
      await api()
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@example.com', password: 'wrong-password' })
        .expect(401);
    });

    it('rejects requests without a valid token', async () => {
      await api().get('/api/v1/children').expect(401);
      await api().get('/api/v1/children').set(auth('not-a-jwt')).expect(401);
    });

    it('rotates refresh tokens and revokes all on reuse', async () => {
      const { refreshToken } = await signup();
      const r1 = await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken })
        .expect(200);
      const next = (r1.body as Tokens).refreshToken;
      expect(next).not.toBe(refreshToken);

      // 失効直後の再送（応答が届かなかった場合など）は拒否するが、全失効はしない
      await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken })
        .expect(401);
      const r2 = await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: next })
        .expect(200);
      const latest = (r2.body as Tokens).refreshToken;

      // 猶予時間を過ぎた使用済みトークンの再利用は盗用とみなし、全トークンを失効
      await prisma.refreshToken.updateMany({
        where: { revokedAt: { not: null } },
        data: { revokedAt: new Date(Date.now() - 60_000) },
      });
      await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken })
        .expect(401);
      await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: latest })
        .expect(401);
    });

    describe('web (cookie mode)', () => {
      const WEB = { 'X-Auth-Mode': 'cookie' };
      const cookieOf = (res: request.Response) => {
        const raw = res.headers['set-cookie'] as unknown as
          string[] | undefined;
        return raw?.find((c) => c.startsWith('__Secure-cradle_rt='));
      };
      const valueOf = (cookie: string) => cookie.split(';')[0];

      it('issues an HttpOnly cookie instead of returning the refresh token', async () => {
        const res = await api()
          .post('/api/v1/auth/signup')
          .set(WEB)
          .send({
            email: `web${Date.now()}@example.com`,
            password: 'password123',
            name: 'web',
          })
          .expect(201);
        expect(res.body).toHaveProperty('accessToken');
        expect(res.body).not.toHaveProperty('refreshToken');
        const cookie = cookieOf(res)!;
        expect(cookie).toMatch(/HttpOnly/);
        expect(cookie).toMatch(/Secure/);
        expect(cookie).toMatch(/SameSite=Strict/);
        expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
      });

      it('refreshes via cookie, rotates it, and logout clears it', async () => {
        const email = `web${Date.now()}@example.com`;
        await signup(); // 別ユーザー（影響しないこと）
        const s = await api()
          .post('/api/v1/auth/signup')
          .set(WEB)
          .send({ email, password: 'password123', name: 'web' })
          .expect(201);
        const c1 = valueOf(cookieOf(s)!);

        const r1 = await api()
          .post('/api/v1/auth/refresh')
          .set({ ...WEB, Cookie: c1 })
          .expect(200);
        expect(r1.body).not.toHaveProperty('refreshToken');
        const c2 = valueOf(cookieOf(r1)!);
        expect(c2).not.toBe(c1);

        // Cookie があってもヘッダーがなければ Cookie は使わない（CSRF 対策）
        await api()
          .post('/api/v1/auth/refresh')
          .set({ Cookie: c2 })
          .send({})
          .expect(400);

        const out = await api()
          .post('/api/v1/auth/logout')
          .set({ ...WEB, Cookie: c2 })
          .expect(204);
        expect(cookieOf(out)).toMatch(/Expires=Thu, 01 Jan 1970/);
        expect(out.headers['cache-control']).toBe('no-store');
        await api()
          .post('/api/v1/auth/refresh')
          .set({ ...WEB, Cookie: c2 })
          .expect(401);
      });

      it('rejects refresh without a cookie or with duplicated cookies', async () => {
        await api().post('/api/v1/auth/refresh').set(WEB).expect(401);
        await api()
          .post('/api/v1/auth/refresh')
          .set({ ...WEB, Cookie: '__Secure-cradle_rt=a; __Secure-cradle_rt=b' })
          .expect(401);
      });
    });

    it('logout revokes the refresh token', async () => {
      const { refreshToken } = await signup();
      await api()
        .post('/api/v1/auth/logout')
        .send({ refreshToken })
        .expect(204);
      await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken })
        .expect(401);
    });
  });

  describe('children & records', () => {
    it('creates children and records, and aggregates stats', async () => {
      const { accessToken } = await signup();
      const h = auth(accessToken);

      const child = await api()
        .post('/api/v1/children')
        .set(h)
        .send({ name: 'たろう', birthDate: '2026-04-01', sex: 'MALE' })
        .expect(201);
      const childId = (child.body as { id: string }).id;
      expect(child.body).toMatchObject({
        name: 'たろう',
        birthDate: '2026-04-01T00:00:00.000Z',
      });

      const list = await api().get('/api/v1/children').set(h).expect(200);
      expect(list.body).toHaveLength(1);

      const post = (body: object) =>
        api().post(`/api/v1/children/${childId}/records`).set(h).send(body);

      // JST 2026-08-27 23:30 と 2026-08-28 01:00 → JST では別の日
      await post({
        type: 'MILK',
        startedAt: '2026-08-27T23:30:00+09:00',
        amountMl: 120,
      }).expect(201);
      await post({
        type: 'MILK',
        startedAt: '2026-08-28T01:00:00+09:00',
        amountMl: 100,
      }).expect(201);
      await post({
        type: 'MILK',
        startedAt: '2026-08-28T05:00:00+09:00',
        amountMl: 80,
      }).expect(201);
      await post({
        type: 'SLEEP',
        startedAt: '2026-08-28T01:30:00+09:00',
        endedAt: '2026-08-28T04:00:00+09:00',
      }).expect(201);
      await post({
        type: 'WEIGHT',
        startedAt: '2026-08-01T10:00:00+09:00',
        weightG: 5200,
      }).expect(201);
      await post({
        type: 'WEIGHT',
        startedAt: '2026-08-28T10:00:00+09:00',
        weightG: 5800,
      }).expect(201);
      await post({
        type: 'MEAL',
        startedAt: '2026-08-28T12:00:00+09:00',
        note: 'おかゆ',
      }).expect(201);

      // 種類ごとの必須項目チェック
      await post({
        type: 'MILK',
        startedAt: '2026-08-28T01:00:00+09:00',
      }).expect(400);
      await post({
        type: 'SLEEP',
        startedAt: '2026-08-28T04:00:00+09:00',
        endedAt: '2026-08-28T01:00:00+09:00',
      }).expect(400);
      await post({
        type: 'MEAL',
        startedAt: '2026-08-28T12:00:00+09:00',
      }).expect(400);

      const records = await api()
        .get(`/api/v1/children/${childId}/records`)
        .query({
          from: '2026-08-28T00:00:00+09:00',
          to: '2026-08-29T00:00:00+09:00',
        })
        .set(h)
        .expect(200);
      expect(records.body).toHaveLength(5);

      const milk = await api()
        .get(`/api/v1/children/${childId}/stats/milk-daily`)
        .query({ from: '2026-08-27', to: '2026-08-28', tz: 'Asia/Tokyo' })
        .set(h)
        .expect(200);
      expect(milk.body).toEqual([
        { date: '2026-08-27', totalMl: 120, count: 1 },
        { date: '2026-08-28', totalMl: 180, count: 2 },
      ]);

      await api()
        .get(`/api/v1/children/${childId}/stats/milk-daily`)
        .query({ from: '2026-08-27', to: '2026-08-28', tz: "UTC'; --" })
        .set(h)
        .expect(400);
      // オフセット表記は Postgres で符号が逆になるので拒否
      await api()
        .get(`/api/v1/children/${childId}/stats/milk-daily`)
        .query({ from: '2026-08-27', to: '2026-08-28', tz: '+09:00' })
        .set(h)
        .expect(400);
      // 未来の記録は拒否
      await post({
        type: 'MILK',
        startedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        amountMl: 100,
      }).expect(400);

      const weight = await api()
        .get(`/api/v1/children/${childId}/stats/weight`)
        .set(h)
        .expect(200);
      expect(
        (weight.body as { weightG: number }[]).map((w) => w.weightG),
      ).toEqual([5200, 5800]);
    });

    it("does not expose another family's children or records", async () => {
      const owner = await signup('A');
      const other = await signup('B');

      const child = await api()
        .post('/api/v1/children')
        .set(auth(owner.accessToken))
        .send({ name: 'はなこ', birthDate: '2025-12-01' })
        .expect(201);
      const childId = (child.body as { id: string }).id;
      const record = await api()
        .post(`/api/v1/children/${childId}/records`)
        .set(auth(owner.accessToken))
        .send({
          type: 'WEIGHT',
          startedAt: '2026-08-28T10:00:00Z',
          weightG: 7000,
        })
        .expect(201);
      const recordId = (record.body as { id: string }).id;

      const h = auth(other.accessToken);
      const list = await api().get('/api/v1/children').set(h).expect(200);
      expect(list.body).toEqual([]);

      await api()
        .get(`/api/v1/children/${childId}/records`)
        .query({ from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' })
        .set(h)
        .expect(404);
      await api()
        .post(`/api/v1/children/${childId}/records`)
        .set(h)
        .send({ type: 'MEAL', startedAt: '2026-08-28T10:00:00Z', note: 'x' })
        .expect(404);
      await api()
        .patch(`/api/v1/children/${childId}`)
        .set(h)
        .send({ name: 'hack' })
        .expect(404);
      await api()
        .get(`/api/v1/children/${childId}/stats/weight`)
        .set(h)
        .expect(404);
      await api().delete(`/api/v1/records/${recordId}`).set(h).expect(404);
      await api().delete(`/api/v1/children/${childId}`).set(h).expect(404);

      // 他家族を指定したこども登録もできない
      const ownerFamily = await prisma.child.findUniqueOrThrow({
        where: { id: childId },
      });
      await api()
        .post('/api/v1/children')
        .set(h)
        .send({
          name: 'x',
          birthDate: '2025-01-01',
          familyId: ownerFamily.familyId,
        })
        .expect(404);

      // 本人は削除できる
      await api()
        .delete(`/api/v1/records/${recordId}`)
        .set(auth(owner.accessToken))
        .expect(204);
    });
  });
});

interface Tokens {
  accessToken: string;
  refreshToken: string;
}
