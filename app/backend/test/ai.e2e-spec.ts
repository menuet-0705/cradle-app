import type { BaseMessage } from '@langchain/core/messages';
import type { INestApplication } from '@nestjs/common';
import { BadGatewayException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { z } from 'zod';
import { AI_MODEL, type AiModel } from '../src/ai/ai-model.js';
import {
  reportPeriodEnd,
  WeeklyReportJob,
} from '../src/ai/weekly-report.job.js';
import { configureApp } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { RateLimitStore } from '../src/common/rate-limit.js';
import { MAILER, type MailMessage } from '../src/mail/mailer.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const CRON_SECRET = 'test-cron-secret-0123456789-0123456789';
const DAY_MS = 24 * 60 * 60 * 1000;

const OUTPUTS: Record<string, unknown> = {
  meal_analysis: {
    preferences: ['かぼちゃが好き'],
    frequentFoods: ['かぼちゃ'],
    possiblyLacking: [{ nutrient: '鉄分', reason: '肉・魚が少ない' }],
  },
  meal_plan: {
    suggestions: [1, 2, 3].map((i) => ({
      dish: `料理${i}`,
      reason: '理由',
      nutrients: ['鉄分'],
      caution: '小さく刻む',
    })),
  },
  chart_comment_weight: {
    headline: '順調に増えています',
    points: ['1 週間で 150 g 増えています'],
    advice: 'この調子で記録を続けましょう',
  },
  chart_comment_milk: {
    headline: 'ミルクの量は安定しています',
    points: ['1 日 600 ml 前後です'],
    advice: '無理なく続けましょう',
  },
  weekly_report: {
    headline: 'よく食べた 1 週間',
    goodPoints: ['毎日食事ができました'],
    concerns: [],
    trends: ['食事の回数が安定しています'],
  },
};

describe('AI features (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sent: MailMessage[] = [];
  const prompts: string[] = [];
  let failNext = false;
  const model: AiModel = {
    name: 'fake:model',
    generate<T extends Record<string, unknown>>(
      schema: z.ZodType<T>,
      messages: BaseMessage[],
      { name }: { name: string },
    ) {
      prompts.push(messages.map((m) => m.text).join('\n'));
      if (failNext) {
        failNext = false;
        return Promise.reject(new BadGatewayException('AI generation failed'));
      }
      return Promise.resolve(schema.parse(OUTPUTS[name]));
    },
  };
  const mailer = {
    send: (m: MailMessage) => {
      sent.push(m);
      return Promise.resolve();
    },
  };

  const api = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  let seq = 0;
  const signup = async (name: string) => {
    const email = `ai${Date.now()}-${seq++}@example.com`;
    const res = await api()
      .post('/api/v1/auth/signup')
      .send({ email, password: 'password123', name })
      .expect(201);
    return { email, token: (res.body as { accessToken: string }).accessToken };
  };
  const addChild = async (token: string, name: string) =>
    (
      await api()
        .post('/api/v1/children')
        .set(auth(token))
        .send({ name, birthDate: '2025-12-01' })
        .expect(201)
    ).body as { id: string };
  const addMeal = (token: string, childId: string, at: Date, note: string) =>
    api()
      .post(`/api/v1/children/${childId}/records`)
      .set(auth(token))
      .send({
        type: 'MEAL',
        startedAt: at.toISOString(),
        mealSlot: 'LUNCH',
        tz: 'Asia/Tokyo',
        note,
      })
      .expect(201);
  const suggest = (token: string, childId: string) =>
    api()
      .post(`/api/v1/children/${childId}/ai/meal-suggestions`)
      .set(auth(token));
  const cron = (authorization?: string) => {
    const req = api().get('/api/v1/internal/cron/weekly-reports');
    return authorization ? req.set('Authorization', authorization) : req;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .overrideProvider(AI_MODEL)
      .useValue(model)
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    // 一度だけ 127.0.0.1 で待ち受ける。supertest に任せると、リクエストごとに全アドレス（::）の
    // 空きポートで待ち受け、macOS では他のアプリが 127.0.0.1 で使っているポートと重なって
    // そのアプリにリクエストが届くことがある（たまに 401・404 になる不安定なテストの原因）
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`
      SELECT current_database() AS db`;
    if (!db.endsWith('_test')) throw new Error(`Refusing to use ${db}`);
  });

  beforeEach(() => {
    app.get(RateLimitStore).clear();
    sent.length = 0;
    prompts.length = 0;
    failNext = false;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('meal suggestions', () => {
    it('suggests meals from the last month, up to 3 times a day per child', async () => {
      const mama = await signup('ママ');
      const child = await addChild(mama.token, 'はなこ');

      // 食事の記録がなければ LLM を呼ばない
      const empty = await suggest(mama.token, child.id).expect(422);
      expect(empty.body).toMatchObject({ code: 'NO_MEAL_RECORDS' });
      expect(prompts).toHaveLength(0);

      await addMeal(
        mama.token,
        child.id,
        new Date(Date.now() - DAY_MS),
        'はなこ かぼちゃがゆ 完食',
      );
      // 1 か月より前の記録は使わない
      await addMeal(
        mama.token,
        child.id,
        new Date(Date.now() - 40 * DAY_MS),
        '40日前のメニュー',
      );

      // 失敗した分は回数に数えない
      failNext = true;
      await suggest(mama.token, child.id).expect(502);

      const first = await suggest(mama.token, child.id).expect(201);
      expect(first.body).toMatchObject({
        remainingToday: 2,
        enabled: true,
        suggestion: {
          content: {
            preferences: ['かぼちゃが好き'],
            possiblyLacking: [{ nutrient: '鉄分' }],
          },
        },
      });
      expect(
        (first.body as { suggestion: { content: { suggestions: unknown[] } } })
          .suggestion.content.suggestions,
      ).toHaveLength(3);

      expect(JSON.stringify(first.body)).not.toContain('fake:model');

      // LLM には記録と月齢だけを渡し、名前は送らない（メモ中の名前も伏せる）
      const prompt = prompts.join('\n');
      expect(prompt).toContain('（こども） かぼちゃがゆ 完食');
      expect(prompt).not.toContain('40日前のメニュー');
      expect(prompt).not.toContain('はなこ');
      expect(prompt).not.toContain('ママ');
      expect(prompt).not.toContain(mama.email);

      const latest = await api()
        .get(`/api/v1/children/${child.id}/ai/meal-suggestions/latest`)
        .set(auth(mama.token))
        .expect(200);
      expect(latest.body).toMatchObject({
        remainingToday: 2,
        suggestion: {
          id: (first.body as { suggestion: { id: string } }).suggestion.id,
        },
      });

      await suggest(mama.token, child.id).expect(201);
      const third = await suggest(mama.token, child.id).expect(201);
      expect(third.body).toMatchObject({ remainingToday: 0 });
      const over = await suggest(mama.token, child.id).expect(429);
      expect(over.body).toMatchObject({ code: 'DAILY_LIMIT' });

      // 同時に依頼されても上限を超えない（生成前に枠を確保する）
      const other = await addChild(mama.token, 'じろう');
      await addMeal(
        mama.token,
        other.id,
        new Date(Date.now() - DAY_MS),
        'うどん',
      );
      const results = await Promise.all(
        Array.from({ length: 6 }, () => suggest(mama.token, other.id)),
      );
      expect(
        results.filter((r) => r.status === 201).length,
      ).toBeLessThanOrEqual(3);
      expect(
        await prisma.mealSuggestion.count({ where: { childId: other.id } }),
      ).toBeLessThanOrEqual(3);
    });

    it("does not reveal or use other families' children", async () => {
      const mama = await signup('ママ');
      const child = await addChild(mama.token, 'たろう');
      await addMeal(
        mama.token,
        child.id,
        new Date(Date.now() - DAY_MS),
        'パン',
      );
      const stranger = await signup('他人');

      await suggest(stranger.token, child.id).expect(404);
      await api()
        .get(`/api/v1/children/${child.id}/ai/meal-suggestions/latest`)
        .set(auth(stranger.token))
        .expect(404);
      await api()
        .get(`/api/v1/children/${child.id}/ai/weekly-reports`)
        .set(auth(stranger.token))
        .expect(404);
      expect(prompts).toHaveLength(0);
    });
  });

  describe('meal suggestion attempts', () => {
    it('counts failures as attempts so LLM calls stay bounded', async () => {
      const mama = await signup('ママ');
      const child = await addChild(mama.token, 'けんた');
      await addMeal(
        mama.token,
        child.id,
        new Date(Date.now() - DAY_MS),
        'パン',
      );

      for (let i = 0; i < 6; i++) {
        failNext = true;
        await suggest(mama.token, child.id).expect(502);
      }
      const callsBefore = prompts.length;
      const res = await suggest(mama.token, child.id).expect(429);
      expect(res.body).toMatchObject({ code: 'DAILY_LIMIT' });
      expect(prompts).toHaveLength(callsBefore); // 上限後は LLM を呼ばない
      const latest = await api()
        .get(`/api/v1/children/${child.id}/ai/meal-suggestions/latest`)
        .set(auth(mama.token))
        .expect(200);
      expect(latest.body).toMatchObject({
        suggestion: null,
        remainingToday: 0,
      });
    });

    it('limits children per family', async () => {
      const mama = await signup('ママ');
      for (let i = 0; i < 10; i++) await addChild(mama.token, `こども${i}`);
      const res = await api()
        .post('/api/v1/children')
        .set(auth(mama.token))
        .send({ name: '11人目', birthDate: '2025-12-01' })
        .expect(409);
      expect(res.body).toMatchObject({ code: 'TOO_MANY_CHILDREN' });
    });
  });

  describe('weekly reports (cron)', () => {
    it('requires CRON_SECRET', async () => {
      await cron().expect(401);
      await cron('Bearer wrong-secret').expect(401);
      await cron(CRON_SECRET).expect(401); // Bearer なし
    });

    it('creates one report per child for the week and emails family members once', async () => {
      const periodEnd = reportPeriodEnd(new Date());
      const inPeriod = new Date(+periodEnd - 2 * DAY_MS);

      const mama = await signup('ママ');
      const child = await addChild(mama.token, 'さくら');
      await addMeal(mama.token, child.id, inPeriod, 'にんじんのおかゆ');

      // 通知をオフにした人には送らない
      const papa = await signup('パパ');
      const papaChild = await addChild(papa.token, 'ゆうた');
      await addMeal(papa.token, papaChild.id, inPeriod, 'バナナ');
      await api()
        .patch('/api/v1/me/notification-settings')
        .set(auth(papa.token))
        .send({ weeklyReportEmail: false })
        .expect(200, { weeklyReportEmail: false });

      // 記録がないこどもは対象外
      const quiet = await addChild(mama.token, 'しずか');

      // 1 回目: 生成だけ（通知はしない）
      const res = await cron(`Bearer ${CRON_SECRET}`).expect(200);
      expect(res.body).toMatchObject({
        periodEnd: periodEnd.toISOString(),
        remaining: 0,
        notified: 0,
      });
      expect(sent.filter((m) => m.to === mama.email)).toHaveLength(0);
      // 2 回目: 作るものが残っていないので通知する
      await cron(`Bearer ${CRON_SECRET}`).expect(200);

      const reports = await api()
        .get(`/api/v1/children/${child.id}/ai/weekly-reports`)
        .set(auth(mama.token))
        .expect(200);
      expect(reports.body).toMatchObject([
        {
          periodEnd: periodEnd.toISOString(),
          periodStart: new Date(+periodEnd - 7 * DAY_MS).toISOString(),
          summary: { meals: { count: 1 } },
          content: OUTPUTS.weekly_report as object,
        },
      ]);
      expect(
        await prisma.weeklyReport.count({ where: { childId: quiet.id } }),
      ).toBe(0);

      const toMama = sent.filter((m) => m.to === mama.email);
      expect(toMama).toHaveLength(1);
      expect(toMama[0].text).toContain('さくらさん');
      expect(toMama[0].text).not.toContain('にんじん'); // レポートの中身はメールに載せない
      expect(sent.filter((m) => m.to === papa.email)).toHaveLength(0);

      // 再実行しても重複して作らず、二重に通知しない
      sent.length = 0;
      await cron(`Bearer ${CRON_SECRET}`).expect(200);
      expect(
        await prisma.weeklyReport.count({ where: { childId: child.id } }),
      ).toBe(1);
      expect(sent.filter((m) => m.to === mama.email)).toHaveLength(0);
    });
  });

  describe('weekly reports (final run)', () => {
    it('only notifies on the final run, even if some reports are not created', async () => {
      const job = app.get(WeeklyReportJob);
      const periodEnd = reportPeriodEnd(new Date());
      const mama = await signup('ママ');
      const child = await addChild(mama.token, 'みお');
      await addMeal(
        mama.token,
        child.id,
        new Date(+periodEnd - DAY_MS),
        'りんご',
      );

      // 23:00 JST 以降の回は生成せず、未通知の分を通知するだけ
      const result = await job.run(new Date(+periodEnd + 6.5 * 60 * 60 * 1000));
      expect(result.created).toBe(0);
      expect(result.remaining).toBeGreaterThan(0);
      expect(
        await prisma.weeklyReport.count({ where: { childId: child.id } }),
      ).toBe(0);
      expect(prompts).toHaveLength(0);
    });

    it('notifies unnotified reports on the final run', async () => {
      const job = app.get(WeeklyReportJob);
      const periodEnd = reportPeriodEnd(new Date());
      const mama = await signup('ママ');
      const child = await addChild(mama.token, 'れん');
      await addMeal(
        mama.token,
        child.id,
        new Date(+periodEnd - DAY_MS),
        'みかん',
      );

      // 17:00 の回で生成（通知はまだ）
      const generated = await job.run(new Date(+periodEnd + 60_000));
      expect(generated.notified).toBe(0);
      expect(
        await prisma.weeklyReport.count({ where: { childId: child.id } }),
      ).toBe(1);
      // 他のテストで作られた「作れないこども」が残っていても、最後の回では通知する
      const final = await job.run(new Date(+periodEnd + 6.5 * 60 * 60 * 1000));
      expect(final.notified).toBeGreaterThan(0);
      expect(sent.filter((m) => m.to === mama.email)).toHaveLength(1);
    });
  });

  describe('children limit', () => {
    it('does not exceed the limit with concurrent requests', async () => {
      const mama = await signup('ママ');
      const results = await Promise.all(
        Array.from({ length: 14 }, (_, i) =>
          api()
            .post('/api/v1/children')
            .set(auth(mama.token))
            .send({ name: `こども${i}`, birthDate: '2025-12-01' }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(10);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    });
  });

  describe('per-user limit', () => {
    it('keeps counting after the child is deleted (new accounts: 6 per day)', async () => {
      const mama = await signup('ママ');
      // 家族の最後の 1 人は削除できないので、削除しないこどもを 1 人登録しておく
      await addChild(mama.token, 'のこる子');
      for (let round = 0; round < 2; round++) {
        const child = await addChild(mama.token, `こども${round}`);
        await addMeal(
          mama.token,
          child.id,
          new Date(Date.now() - DAY_MS),
          'パン',
        );
        for (let i = 0; i < 3; i++) {
          await suggest(mama.token, child.id).expect(201);
        }
        // こどもを削除しても利用回数は戻らない
        await api()
          .delete(`/api/v1/children/${child.id}`)
          .set(auth(mama.token))
          .expect(204);
      }
      const child = await addChild(mama.token, 'こども2');
      await addMeal(
        mama.token,
        child.id,
        new Date(Date.now() - DAY_MS),
        'パン',
      );
      // 画面の残り回数にも利用者単位の上限が反映される
      const latest = await api()
        .get(`/api/v1/children/${child.id}/ai/meal-suggestions/latest`)
        .set(auth(mama.token))
        .expect(200);
      expect(latest.body).toMatchObject({ remainingToday: 0 });
      const res = await suggest(mama.token, child.id).expect(429);
      expect(res.body).toMatchObject({ code: 'DAILY_LIMIT' });
    });
  });

  describe('chart comments', () => {
    const tz = 'Asia/Tokyo';
    const chartUrl = (childId: string, chart: string) =>
      `/api/v1/children/${childId}/ai/chart-comments/${chart}`;
    type ChartState = {
      comment: { content: { headline: string } } | null;
      needsUpdate: boolean;
      generating: boolean;
      retryLater: boolean;
      limitReached: boolean;
      enabled: boolean;
    };
    const state = async (token: string, childId: string, chart: string) =>
      (
        await api()
          .get(chartUrl(childId, chart))
          .query({ tz })
          .set(auth(token))
          .expect(200)
      ).body as ChartState;
    const create = (token: string, childId: string, chart: string) =>
      api().post(chartUrl(childId, chart)).set(auth(token)).send({ tz });
    const addWeight = (token: string, childId: string, at: Date, g: number) =>
      api()
        .post(`/api/v1/children/${childId}/records`)
        .set(auth(token))
        .send({ type: 'WEIGHT', startedAt: at.toISOString(), weightG: g, tz })
        .expect(201);
    // 日本時間で今日の、いまより少し前（0 時直後に実行しても今日になるよう、1 秒前）
    const justNow = () => new Date(Date.now() - 1000);
    // 失敗した直後の待ち時間（5 分）を過ぎたことにする
    const expireFailures = (childId: string) =>
      prisma.chartComment.updateMany({
        where: { childId, failedAt: { not: null } },
        data: { failedAt: new Date(Date.now() - 10 * 60 * 1000) },
      });

    it('comments once a day when there is a record today', async () => {
      const mama = await signup('ママ');
      const child = await addChild(mama.token, 'たろう');

      // 記録がない・今日の記録がないときは作らない
      expect(await state(mama.token, child.id, 'weight')).toMatchObject({
        comment: null,
        needsUpdate: false,
        generating: false,
        limitReached: false,
        enabled: true,
      });
      await addWeight(
        mama.token,
        child.id,
        new Date(Date.now() - DAY_MS),
        6000,
      );
      expect(await state(mama.token, child.id, 'weight')).toMatchObject({
        needsUpdate: false,
      });
      await create(mama.token, child.id, 'weight')
        .expect(201)
        .expect((res) => expect(res.body).toMatchObject({ comment: null }));
      expect(prompts).toHaveLength(0);

      // 今日の記録があり、今日のコメントがまだなければ作る
      await addWeight(mama.token, child.id, justNow(), 6150);
      expect(await state(mama.token, child.id, 'weight')).toMatchObject({
        needsUpdate: true,
      });
      const created = await create(mama.token, child.id, 'weight').expect(201);
      expect(created.body).toMatchObject({
        comment: { content: { headline: '順調に増えています' } },
        needsUpdate: false,
        generating: false,
      });
      expect(prompts).toHaveLength(1);
      // 数値だけを渡し、名前は渡さない
      expect(prompts[0]).toContain('6150');
      expect(prompts[0]).not.toContain('たろう');

      // 1 日 1 回: 同じ日に記録が変わっても作り直さない
      await addWeight(mama.token, child.id, justNow(), 6160);
      expect(await state(mama.token, child.id, 'weight')).toMatchObject({
        needsUpdate: false,
        comment: { content: { headline: '順調に増えています' } },
      });
      await create(mama.token, child.id, 'weight').expect(201);
      expect(prompts).toHaveLength(1);

      // ミルクのグラフは別に数える。今日のミルクの記録がなければ作らない
      expect(await state(mama.token, child.id, 'milk')).toMatchObject({
        comment: null,
        needsUpdate: false,
      });
      await api()
        .post(`/api/v1/children/${child.id}/records`)
        .set(auth(mama.token))
        .send({
          type: 'MILK',
          startedAt: justNow().toISOString(),
          amountMl: 120,
        })
        .expect(201);
      expect(await state(mama.token, child.id, 'milk')).toMatchObject({
        needsUpdate: true,
      });
      const milk = await create(mama.token, child.id, 'milk').expect(201);
      expect(milk.body).toMatchObject({
        comment: { content: { headline: 'ミルクの量は安定しています' } },
      });
      expect(prompts[1]).toContain('120');

      // 食事の提案の回数とは別の枠（グラフを開いても減らない）
      const meal = await api()
        .get(`/api/v1/children/${child.id}/ai/meal-suggestions/latest`)
        .set(auth(mama.token))
        .expect(200);
      expect(meal.body).toMatchObject({ remainingToday: 3 });
    });

    it('creates once when family members open it at the same time', async () => {
      const mama = await signup('ママ');
      const child = await addChild(mama.token, 'はなこ');
      await addWeight(mama.token, child.id, justNow(), 7000);
      await Promise.all([
        create(mama.token, child.id, 'weight').expect(201),
        create(mama.token, child.id, 'weight').expect(201),
        create(mama.token, child.id, 'weight').expect(201),
      ]);
      expect(prompts).toHaveLength(1);
      expect(await state(mama.token, child.id, 'weight')).toMatchObject({
        needsUpdate: false,
        comment: { content: { headline: '順調に増えています' } },
      });
    });

    it('waits after a failure and stops at the daily attempt limit', async () => {
      const mama = await signup('ママ');
      const child = await addChild(mama.token, 'さぶろう');
      await addWeight(mama.token, child.id, justNow(), 7000);

      for (let i = 0; i < 3; i++) {
        failNext = true;
        await create(mama.token, child.id, 'weight').expect(502);
        // 失敗した直後は自動で作り直さない（タブの行き来で失敗を繰り返さない）
        expect(await state(mama.token, child.id, 'weight')).toMatchObject({
          comment: null,
          needsUpdate: false,
          retryLater: i < 2,
          limitReached: i === 2,
        });
        // 待ち時間中は作らずに今の状態を返す
        await create(mama.token, child.id, 'weight')
          .expect(201)
          .expect((res) => expect(res.body).toMatchObject({ comment: null }));
        await expireFailures(child.id);
      }
      expect(prompts).toHaveLength(3);
      // 失敗も含めて 1 日 3 回まで。上限に達したことを返す
      expect(await state(mama.token, child.id, 'weight')).toMatchObject({
        needsUpdate: false,
        limitReached: true,
      });
      await create(mama.token, child.id, 'weight')
        .expect(429)
        .expect((res) =>
          expect(res.body).toMatchObject({ code: 'DAILY_LIMIT' }),
        );
      expect(prompts).toHaveLength(3);
    });

    it('limits each user per day, even if children are deleted', async () => {
      // 作成から 1 日以内のアカウントは 1 日 6 回（食事の提案とは別の枠）
      const mama = await signup('ママ');
      // 家族の最後の 1 人は削除できないので、削除しないこどもを 1 人登録しておく
      await addChild(mama.token, 'のこる子');
      for (let i = 0; i < 6; i++) {
        const child = await addChild(mama.token, `こども${i}`);
        await addWeight(mama.token, child.id, justNow(), 7000);
        await create(mama.token, child.id, 'weight').expect(201);
        // こどもを削除しても、利用者の回数は戻らない
        await api()
          .delete(`/api/v1/children/${child.id}`)
          .set(auth(mama.token))
          .expect(204);
      }
      expect(prompts).toHaveLength(6);
      const child = await addChild(mama.token, 'こども6');
      await addWeight(mama.token, child.id, justNow(), 7000);
      // 上限に達したことを状態で返す（開くたびに作成を依頼させない）
      expect(await state(mama.token, child.id, 'weight')).toMatchObject({
        needsUpdate: false,
        limitReached: true,
      });
      await create(mama.token, child.id, 'weight')
        .expect(429)
        .expect((res) =>
          expect(res.body).toMatchObject({ code: 'DAILY_LIMIT' }),
        );
      expect(prompts).toHaveLength(6);
      // 上限で断った分は試行に数えず、コメントの行も残さない
      expect(
        await prisma.chartComment.count({ where: { childId: child.id } }),
      ).toBe(0);
      // 食事の提案の回数は減っていない
      await addMeal(mama.token, child.id, justNow(), 'パン');
      const meal = await api()
        .get(`/api/v1/children/${child.id}/ai/meal-suggestions/latest`)
        .set(auth(mama.token))
        .expect(200);
      expect(meal.body).toMatchObject({ remainingToday: 3 });
    });

    it('does not let a different time zone reset the daily attempts', async () => {
      const mama = await signup('ママ');
      const child = await addChild(mama.token, 'しろう');
      await addWeight(mama.token, child.id, justNow(), 7000);
      // 失敗を 3 回（それぞれ待ち時間を過ぎたことにする）
      for (let i = 0; i < 3; i++) {
        failNext = true;
        await create(mama.token, child.id, 'weight').expect(502);
        await expireFailures(child.id);
      }
      // 別の地域のタイムゾーンを送って「今日」をずらしても、試行は JST の日で数える
      for (const otherTz of ['Pacific/Kiritimati', 'Etc/GMT+12', 'UTC']) {
        await api()
          .post(chartUrl(child.id, 'weight'))
          .set(auth(mama.token))
          .send({ tz: otherTz })
          .expect((res) => expect([201, 429]).toContain(res.status));
      }
      expect(prompts).toHaveLength(3);
    });

    it("validates input and hides other families' children", async () => {
      const mama = await signup('ママ');
      const other = await signup('よそ');
      const child = await addChild(mama.token, 'じろう');
      await api()
        .get(chartUrl(child.id, 'weight'))
        .query({ tz })
        .set(auth(other.token))
        .expect(404);
      await create(other.token, child.id, 'weight').expect(404);
      await api()
        .get(chartUrl(child.id, 'sleep'))
        .query({ tz })
        .set(auth(mama.token))
        .expect(400);
      await api()
        .get(chartUrl(child.id, 'weight'))
        .query({ tz: '+09:00' })
        .set(auth(mama.token))
        .expect(400);
      await api().get(chartUrl(child.id, 'weight')).query({ tz }).expect(401);
    });
  });

  describe('notification settings', () => {
    it('defaults to on and validates the body', async () => {
      const user = await signup('ユーザー');
      await api()
        .get('/api/v1/me/notification-settings')
        .set(auth(user.token))
        .expect(200, { weeklyReportEmail: true });
      await api()
        .patch('/api/v1/me/notification-settings')
        .set(auth(user.token))
        .send({ weeklyReportEmail: 'no' })
        .expect(400);
      await api()
        .patch('/api/v1/me/notification-settings')
        .set(auth(user.token))
        .send({ weeklyReportEmail: false, extra: 1 })
        .expect(400);
      await api().get('/api/v1/me/notification-settings').expect(401);
    });
  });
});
