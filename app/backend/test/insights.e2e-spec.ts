import type { INestApplication } from '@nestjs/common';
import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { RateLimitStore } from '../src/common/rate-limit.js';
import type {
  MealSuggestionInput,
  WeeklyReportInput,
} from '../src/insights/aggregate.js';
import { reportPeriod } from '../src/insights/aggregate.js';
import {
  INSIGHTS_MODEL,
  type BatchOutcome,
  type InsightsModel,
} from '../src/insights/insights-model.js';
import type {
  MealSuggestionContent,
  WeeklyReportContent,
} from '../src/insights/insights.schemas.js';
import { MAILER, type MailMessage } from '../src/mail/mailer.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const CRON = { Authorization: 'Bearer test-cron-secret-0123456789-0123456789' };
const HOUR = 60 * 60 * 1000;

const report = (headline: string): WeeklyReportContent => ({
  headline,
  goodPoints: ['よく眠れました'],
  concerns: [],
  trends: [],
  nextWeekTips: ['お散歩を続けましょう'],
  consultDoctor: false,
  consultReason: '',
});

const carrotIdea = {
  title: 'にんじんと鶏ささみのおかゆ',
  foods: ['にんじん', '鶏ささみ', 'おかゆ'],
  reason: '好きなにんじんと、不足気味のたんぱく質',
  nutrients: ['たんぱく質'],
  tips: 'ささみは細かくほぐす',
};

/** Claude の代わり。受け取った入力を記録し、決まった結果を返す */
class FakeInsightsModel implements InsightsModel {
  readonly modelName = 'claude-sonnet-5';
  mealInputs: MealSuggestionInput[] = [];
  suggestion: MealSuggestionContent = {
    summary: 'にんじんが好きなようです',
    suggestions: [carrotIdea],
    cautions: [],
  };
  failNextSuggest = false;
  failNextSubmit = false;
  failFetch = new Set<string>();
  batches = new Map<string, { customId: string; input: WeeklyReportInput }[]>();
  ended = true;
  failIds = new Set<string>();
  seq = 0;

  suggestMeals(input: MealSuggestionInput) {
    this.mealInputs.push(input);
    if (this.failNextSuggest) {
      this.failNextSuggest = false;
      return Promise.reject(new ServiceUnavailableException());
    }
    return Promise.resolve(this.suggestion);
  }

  submitWeeklyReports(items: { customId: string; input: WeeklyReportInput }[]) {
    if (this.failNextSubmit) {
      this.failNextSubmit = false;
      return Promise.reject(new ServiceUnavailableException());
    }
    const id = `batch_${++this.seq}`;
    this.batches.set(id, items);
    return Promise.resolve(id);
  }

  fetchWeeklyReports(batchId: string): Promise<BatchOutcome> {
    if (this.failFetch.has(batchId)) {
      return Promise.reject(new Error('network'));
    }
    const results = new Map<string, WeeklyReportContent | null>();
    if (!this.ended) return Promise.resolve({ ended: false, results });
    for (const { customId } of this.batches.get(batchId) ?? []) {
      results.set(
        customId,
        this.failIds.has(customId) ? null : report('いい週'),
      );
    }
    return Promise.resolve({ ended: true, results });
  }
}

describe('AI insights (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let model: FakeInsightsModel;
  const sent: MailMessage[] = [];

  const api = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  let seq = 0;
  const signup = async (name: string, { consent = true } = {}) => {
    const email = `ai${Date.now()}-${seq++}@example.com`;
    const res = await api()
      .post('/api/v1/auth/signup')
      .send({ email, password: 'password123', name })
      .expect(201);
    const token = (res.body as { accessToken: string }).accessToken;
    const families = await api()
      .get('/api/v1/families')
      .set(auth(token))
      .expect(200);
    const familyId = (families.body as { id: string }[])[0].id;
    if (consent) {
      await api()
        .post(`/api/v1/families/${familyId}/ai-consent`)
        .set(auth(token))
        .send({ version: 1 })
        .expect(200);
    }
    return { email, token, familyId };
  };
  const addChild = async (token: string, body: object) =>
    (
      await api()
        .post('/api/v1/children')
        .set(auth(token))
        .send(body)
        .expect(201)
    ).body as { id: string; avoidFoods: string | null };
  const suggest = (token: string, childId: string) =>
    api().post(`/api/v1/children/${childId}/meal-suggestions`).set(auth(token));

  beforeAll(async () => {
    model = new FakeInsightsModel();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(INSIGHTS_MODEL)
      .useValue(model)
      .overrideProvider(MAILER)
      .useValue({
        send: (m: MailMessage) => {
          sent.push(m);
          return Promise.resolve();
        },
      })
      .compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
    const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`
      SELECT current_database() AS db`;
    if (!db.endsWith('_test')) throw new Error(`Refusing to use ${db}`);
  });

  beforeEach(() => {
    app.get(RateLimitStore).clear();
    sent.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('consent', () => {
    it('requires the owner to consent before AI features run', async () => {
      const mama = await signup('ママ', { consent: false });
      const child = await addChild(mama.token, {
        name: 'たろう',
        birthDate: '2026-03-01',
      });
      const families = await api()
        .get('/api/v1/families')
        .set(auth(mama.token))
        .expect(200);
      expect(families.body[0]).toMatchObject({ aiEnabled: false });

      const denied = await suggest(mama.token, child.id).expect(403);
      expect(denied.body).toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
      expect(model.mealInputs).toHaveLength(0);

      // 古い版の同意は受け付けない
      const outdated = await api()
        .post(`/api/v1/families/${mama.familyId}/ai-consent`)
        .set(auth(mama.token))
        .send({ version: 0 })
        .expect(400);
      expect(outdated.body).toBeDefined();
      await api()
        .post(`/api/v1/families/${mama.familyId}/ai-consent`)
        .set(auth(mama.token))
        .send({ version: 2 })
        .expect(409);

      // メンバー（管理者以外）は同意・取り消しできない
      const papa = await signup('パパ', { consent: false });
      await prisma.familyMember.create({
        data: {
          familyId: mama.familyId,
          userId: (await prisma.user.findFirstOrThrow({
            where: { email: papa.email },
          }))!.id,
          role: 'MEMBER',
        },
      });
      const byMember = await api()
        .post(`/api/v1/families/${mama.familyId}/ai-consent`)
        .set(auth(papa.token))
        .send({ version: 1 })
        .expect(403);
      expect(byMember.body).toMatchObject({ code: 'OWNER_ONLY' });

      await api()
        .post(`/api/v1/families/${mama.familyId}/ai-consent`)
        .set(auth(mama.token))
        .send({ version: 1 })
        .expect(200);
      await suggest(mama.token, child.id).expect(201);

      // 取り消すと使えなくなる
      await api()
        .delete(`/api/v1/families/${mama.familyId}/ai-consent`)
        .set(auth(mama.token))
        .expect(200);
      await suggest(mama.token, child.id).expect(403);
    });
  });

  describe('meal suggestions', () => {
    it('suggests meals from the last month without sending personal data', async () => {
      const mama = await signup('ママ');
      const child = await addChild(mama.token, {
        name: 'たろう',
        birthDate: '2026-03-01',
        avoidFoods: '卵',
      });
      expect(child.avoidFoods).toBe('卵');

      const meal = await api()
        .post(`/api/v1/children/${child.id}/records`)
        .set(auth(mama.token))
        .send({
          type: 'MEAL',
          startedAt: new Date(Date.now() - HOUR).toISOString(),
          note: 'にんじんのペースト',
          mealAmount: 'ALL',
          mealReaction: 'LIKED',
        })
        .expect(201);
      expect(meal.body).toMatchObject({
        mealAmount: 'ALL',
        mealReaction: 'LIKED',
      });

      const latest0 = await api()
        .get(`/api/v1/children/${child.id}/meal-suggestions/latest`)
        .set(auth(mama.token))
        .expect(200);
      expect(latest0.body).toEqual({
        suggestion: null,
        limitPerDay: 3,
        remainingToday: 3,
      });

      const res = await suggest(mama.token, child.id).expect(201);
      expect(res.body).toMatchObject({
        remainingToday: 2,
        suggestion: {
          model: 'claude-sonnet-5',
          content: { summary: 'にんじんが好きなようです' },
          createdBy: { name: 'ママ' },
        },
      });

      // Claude に渡した内容: 月齢・避けたい食材・食事の記録（名前は含めない）
      const input = model.mealInputs.at(-1)!;
      expect(input.child).toMatchObject({ avoidFoods: '卵' });
      expect(input.mealsLast30Days).toEqual([
        expect.objectContaining({
          food: 'にんじんのペースト',
          amount: 'ぜんぶ',
          reaction: '好き',
        }),
      ]);
      expect(JSON.stringify(input)).not.toContain('たろう');
      expect(JSON.stringify(input)).not.toContain('ママ');

      const latest = await api()
        .get(`/api/v1/children/${child.id}/meal-suggestions/latest`)
        .set(auth(mama.token))
        .expect(200);
      expect(latest.body.suggestion.id).toBe(res.body.suggestion.id);
    });

    it('never exceeds the daily limit, even with simultaneous requests', async () => {
      const mama = await signup('ママ');
      const child = await addChild(mama.token, {
        name: 'はなこ',
        birthDate: '2025-10-01',
      });
      const results = await Promise.all(
        Array.from({ length: 5 }, () => suggest(mama.token, child.id)),
      );
      expect(results.map((r) => r.status).sort()).toEqual([
        201, 201, 201, 429, 429,
      ]);
      const limited = results.find((r) => r.status === 429)!;
      expect(limited.body).toMatchObject({ code: 'SUGGESTION_LIMIT' });
    });

    it('counts failed attempts and keeps showing the last good suggestion', async () => {
      const mama = await signup('ママ');
      const child = await addChild(mama.token, {
        name: 'じろう',
        birthDate: '2025-10-01',
      });
      const ok = await suggest(mama.token, child.id).expect(201);
      model.failNextSuggest = true;
      await suggest(mama.token, child.id).expect(503);
      const latest = await api()
        .get(`/api/v1/children/${child.id}/meal-suggestions/latest`)
        .set(auth(mama.token))
        .expect(200);
      expect(latest.body).toMatchObject({
        remainingToday: 1,
        suggestion: { id: ok.body.suggestion.id },
      });
    });

    it('drops suggestions that contain the child’s avoided foods', async () => {
      const mama = await signup('ママ');
      const child = await addChild(mama.token, {
        name: 'さぶろう',
        birthDate: '2026-01-01',
        avoidFoods: '卵、えび',
      });
      model.suggestion = {
        summary: 's',
        suggestions: [
          { ...carrotIdea, title: '卵がゆ', foods: ['おかゆ', '卵黄'] },
          carrotIdea,
        ],
        cautions: [],
      };
      const res = await suggest(mama.token, child.id).expect(201);
      expect(
        (res.body.suggestion.content.suggestions as { title: string }[]).map(
          (s) => s.title,
        ),
      ).toEqual([carrotIdea.title]);

      // すべて除外されたら提案として扱わない
      model.suggestion = {
        summary: 's',
        suggestions: [{ ...carrotIdea, title: 'えびのおかゆ' }],
        cautions: [],
      };
      await suggest(mama.token, child.id).expect(503);
      model.suggestion = {
        summary: 'にんじんが好きなようです',
        suggestions: [carrotIdea],
        cautions: [],
      };
    });

    it('caps suggestions per family and children per family', async () => {
      const mama = await signup('ママ');
      const kids = [];
      for (let i = 0; i < 4; i++) {
        kids.push(
          await addChild(mama.token, {
            name: `子${i}`,
            birthDate: '2025-10-01',
          }),
        );
      }
      // こども 4 人 × 3 回 = 12 回でも、家族（・人）単位で 1 日 10 回まで
      let ok = 0;
      for (const kid of kids) {
        for (let i = 0; i < 3; i++) {
          app.get(RateLimitStore).clear();
          const r = await suggest(mama.token, kid.id);
          if (r.status === 201) ok++;
        }
      }
      expect(ok).toBe(10);

      for (let i = kids.length; i < 10; i++) {
        await addChild(mama.token, { name: `子${i}`, birthDate: '2025-10-01' });
      }
      const over = await api()
        .post('/api/v1/children')
        .set(auth(mama.token))
        .send({ name: '11人目', birthDate: '2025-10-01' })
        .expect(409);
      expect(over.body).toMatchObject({ code: 'CHILD_LIMIT' });
    });

    it("hides other families' suggestions and reports", async () => {
      const mama = await signup('ママ');
      const child = await addChild(mama.token, {
        name: 'たろう',
        birthDate: '2026-01-01',
      });
      const other = await signup('他人');
      const h = auth(other.token);
      await suggest(other.token, child.id).expect(404);
      await api()
        .get(`/api/v1/children/${child.id}/meal-suggestions/latest`)
        .set(h)
        .expect(404);
      await api()
        .get(`/api/v1/children/${child.id}/weekly-reports`)
        .set(h)
        .expect(404);
      await api()
        .post(`/api/v1/children/${child.id}/meal-suggestions`)
        .expect(401);
    });
  });

  describe('weekly reports', () => {
    const period = () => reportPeriod(new Date());
    const addMilk = (token: string, childId: string, at: Date, ml = 120) =>
      api()
        .post(`/api/v1/children/${childId}/records`)
        .set(auth(token))
        .send({ type: 'MILK', startedAt: at.toISOString(), amountMl: ml })
        .expect(201);
    /** 最後に依頼した Batch の中から、このこどもの入力を探す */
    const inputFor = (childId: string, marker: string) =>
      [...model.batches.values()]
        .flat()
        .find((i) => JSON.stringify(i.input).includes(marker) && i.customId)
        ?.input;

    it('rejects cron calls without the secret', async () => {
      await api().get('/api/v1/cron/weekly-reports/submit').expect(401);
      await api()
        .get('/api/v1/cron/weekly-reports/submit')
        .set({ Authorization: 'Bearer wrong' })
        .expect(401);
      const mama = await signup('ママ');
      // 利用者のトークンでも呼べない
      await api()
        .get('/api/v1/cron/weekly-reports/collect')
        .set(auth(mama.token))
        .expect(401);
    });

    it('creates weekly reports for consenting families only, and never duplicates', async () => {
      model.ended = true;
      const mama = await signup('ママ');
      const child = await addChild(mama.token, {
        name: 'たろう',
        birthDate: '2026-03-01',
      });
      // 締めの金曜（17:00 まで）の記録も含まれること
      await addMilk(
        mama.token,
        child.id,
        new Date(period().end.getTime() - 3 * HOUR),
        137,
      );
      // 記録がないこどもは対象外
      const empty = await addChild(mama.token, {
        name: 'じろう',
        birthDate: '2026-03-01',
      });
      // 同意していない家族は対象外
      const noConsent = await signup('他の家族', { consent: false });
      const other = await addChild(noConsent.token, {
        name: 'はなこ',
        birthDate: '2026-03-01',
      });
      await addMilk(
        noConsent.token,
        other.id,
        new Date(period().end.getTime() - 5 * HOUR),
      );

      await api()
        .get('/api/v1/cron/weekly-reports/submit')
        .set(CRON)
        .expect(200);
      const input = inputFor(child.id, '"milkMl":137');
      expect(input).toBeDefined();
      expect(JSON.stringify(input)).not.toContain('たろう');

      // 同じ週は再実行しても増えない
      await api()
        .get('/api/v1/cron/weekly-reports/submit')
        .set(CRON)
        .expect(200);
      const counts = await Promise.all(
        [child.id, empty.id, other.id].map((childId) =>
          prisma.weeklyReport.count({ where: { childId } }),
        ),
      );
      expect(counts).toEqual([1, 0, 0]);

      await api()
        .get('/api/v1/cron/weekly-reports/collect')
        .set(CRON)
        .expect(200);
      expect(sent.map((m) => m.to)).toContain(mama.email);
      expect(sent[0].subject).toBe('今週のふりかえりレポートができました');

      const list = await api()
        .get(`/api/v1/children/${child.id}/weekly-reports`)
        .set(auth(mama.token))
        .expect(200);
      expect(list.body).toEqual([
        expect.objectContaining({ status: 'READY', headline: 'いい週' }),
      ]);
      expect(list.body[0]).not.toHaveProperty('content');
      const detail = await api()
        .get(`/api/v1/children/${child.id}/weekly-reports/${list.body[0].id}`)
        .set(auth(mama.token))
        .expect(200);
      expect(detail.body.content).toMatchObject({ headline: 'いい週' });

      // 回収をもう一度実行しても、通知は重ならない
      sent.length = 0;
      await api()
        .get('/api/v1/cron/weekly-reports/collect')
        .set(CRON)
        .expect(200);
      expect(sent.map((m) => m.to)).not.toContain(mama.email);
    });

    it('retries a failed submission on the next daily run', async () => {
      const mama = await signup('ママ');
      const child = await addChild(mama.token, {
        name: 'しろう',
        birthDate: '2026-03-01',
      });
      await addMilk(
        mama.token,
        child.id,
        new Date(period().start.getTime() + 2 * HOUR),
        151,
      );
      model.failNextSubmit = true;
      await api()
        .get('/api/v1/cron/weekly-reports/submit')
        .set(CRON)
        .expect(503);
      expect(
        await prisma.weeklyReport.count({ where: { childId: child.id } }),
      ).toBe(0);
      // 毎日の Cron が同じ週のうちに依頼し直す
      await api()
        .get('/api/v1/cron/weekly-reports/collect')
        .set(CRON)
        .expect(200);
      expect(inputFor(child.id, '"milkMl":151')).toBeDefined();
      expect(
        await prisma.weeklyReport.count({ where: { childId: child.id } }),
      ).toBe(1);
    });

    /** 前の週の PENDING レポートと、それに対応する Batch を直接作る */
    const pendingReport = async (childId: string, weeksAgo: number) => {
      const { start, end } = period();
      const shift = weeksAgo * 7 * 24 * HOUR;
      const batchId = await model.submitWeeklyReports([]);
      const created = await prisma.weeklyReport.create({
        data: {
          childId,
          periodStart: new Date(start.getTime() - shift),
          periodEnd: new Date(end.getTime() - shift),
          model: 'claude-sonnet-5',
          batchId,
        },
      });
      model.batches.set(batchId, [
        { customId: created.id, input: {} as never },
      ]);
      return { ...created, batchId };
    };

    it('keeps reports pending until the batch ends, and survives a failing batch', async () => {
      const mama = await signup('ママ');
      const child = await addChild(mama.token, {
        name: 'はなこ',
        birthDate: '2026-01-01',
      });
      const broken = await pendingReport(child.id, 2);
      model.failFetch.add(broken.batchId);
      const report = await pendingReport(child.id, 1);

      model.ended = false;
      await api()
        .get('/api/v1/cron/weekly-reports/collect')
        .set(CRON)
        .expect(200);
      const list = await api()
        .get(`/api/v1/children/${child.id}/weekly-reports`)
        .set(auth(mama.token))
        .expect(200);
      expect(list.body[0]).toMatchObject({ status: 'PENDING', headline: null });

      // 1 つの Batch の取得に失敗しても、他の Batch は回収される
      model.ended = true;
      await api()
        .get('/api/v1/cron/weekly-reports/collect')
        .set(CRON)
        .expect(200);
      const statuses = await prisma.weeklyReport.findMany({
        where: { id: { in: [report.id, broken.id] } },
        select: { id: true, status: true },
      });
      expect(Object.fromEntries(statuses.map((s) => [s.id, s.status]))).toEqual(
        { [report.id]: 'READY', [broken.id]: 'PENDING' },
      );
      model.failFetch.clear();
    });

    it('collects when the list is opened, and leaves the email to the cron', async () => {
      model.ended = true;
      const mama = await signup('ママ');
      const child = await addChild(mama.token, {
        name: 'ごろう',
        birthDate: '2026-01-01',
      });
      await pendingReport(child.id, 1);
      const list = await api()
        .get(`/api/v1/children/${child.id}/weekly-reports`)
        .set(auth(mama.token))
        .expect(200);
      expect(list.body[0]).toMatchObject({
        status: 'READY',
        headline: 'いい週',
      });
      // 利用者のリクエストではメールを送らない（Cron が送る）
      expect(sent.map((m) => m.to)).not.toContain(mama.email);
      await api()
        .get('/api/v1/cron/weekly-reports/collect')
        .set(CRON)
        .expect(200);
      expect(sent.map((m) => m.to)).toContain(mama.email);
    });

    it('does not finish or email reports after consent is revoked', async () => {
      model.ended = true;
      const mama = await signup('ママ');
      const child = await addChild(mama.token, {
        name: 'ななこ',
        birthDate: '2026-01-01',
      });
      const pending = await pendingReport(child.id, 1);
      await api()
        .delete(`/api/v1/families/${mama.familyId}/ai-consent`)
        .set(auth(mama.token))
        .expect(200);
      await api()
        .get('/api/v1/cron/weekly-reports/collect')
        .set(CRON)
        .expect(200);
      const r = await prisma.weeklyReport.findUniqueOrThrow({
        where: { id: pending.id },
      });
      expect(r).toMatchObject({ status: 'FAILED', content: null });
      expect(sent.map((m) => m.to)).not.toContain(mama.email);
    });

    it('marks reports that could not be generated as failed', async () => {
      model.ended = true;
      const mama = await signup('ママ');
      const child = await addChild(mama.token, {
        name: 'ろくろう',
        birthDate: '2026-01-01',
      });
      const failed = await pendingReport(child.id, 2);
      model.failIds.add(failed.id);
      await api()
        .get('/api/v1/cron/weekly-reports/collect')
        .set(CRON)
        .expect(200);
      const r = await prisma.weeklyReport.findUniqueOrThrow({
        where: { id: failed.id },
      });
      expect(r.status).toBe('FAILED');
      expect(sent.map((m) => m.to)).not.toContain(mama.email);
    });
  });
});
