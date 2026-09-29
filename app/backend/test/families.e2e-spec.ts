import type { INestApplication } from '@nestjs/common';
import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/app.factory.js';
import { AppModule } from '../src/app.module.js';
import { RateLimitStore } from '../src/common/rate-limit.js';
import {
  MAILER,
  MailDeliveryUnknownError,
  type MailMessage,
} from '../src/mail/mailer.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

interface Family {
  id: string;
  name: string;
  myRole: 'OWNER' | 'MEMBER';
  members: { userId: string; name: string; role: string }[];
}

describe('family invites (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sent: MailMessage[] = [];
  let failNextSend: 'failed' | 'timeout' | null = null;
  const mailer = {
    send: (m: MailMessage) => {
      if (failNextSend) {
        const kind = failNextSend;
        failNextSend = null;
        return Promise.reject(
          kind === 'timeout'
            ? new MailDeliveryUnknownError()
            : new ServiceUnavailableException(),
        );
      }
      sent.push(m);
      return Promise.resolve();
    },
  };

  const api = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  let seq = 0;
  const signup = async (name: string, email?: string) => {
    email ??= `fam${Date.now()}-${seq++}@example.com`;
    const res = await api()
      .post('/api/v1/auth/signup')
      .send({ email, password: 'password123', name })
      .expect(201);
    const token = (res.body as { accessToken: string }).accessToken;
    const me = await api().get('/api/v1/me').set(auth(token)).expect(200);
    return { email, token, id: (me.body as { id: string }).id };
  };
  const families = async (token: string) =>
    (await api().get('/api/v1/families').set(auth(token)).expect(200))
      .body as Family[];
  const invite = (token: string, familyId: string, email: string) =>
    api()
      .post(`/api/v1/families/${familyId}/invites`)
      .set(auth(token))
      .send({ email });
  /** 最後に送られた招待メールからコードを取り出す */
  const lastCode = () => {
    const text = sent.at(-1)!.text;
    return /\/invite#([2-9A-Z]{10})/.exec(text)![1];
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAILER)
      .useValue(mailer)
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
    // 前のテストが途中で失敗しても、送信の失敗の指定を持ち越さない
    failNextSend = null;
  });

  afterAll(async () => {
    await app.close();
  });

  it('invites by email, and the invitee joins and sees the children', async () => {
    const mama = await signup('ママ');
    const [family] = await families(mama.token);
    expect(family).toMatchObject({ name: 'ママの家族', myRole: 'OWNER' });
    await api()
      .post('/api/v1/children')
      .set(auth(mama.token))
      .send({ name: 'たろう', birthDate: '2026-06-10' })
      .expect(201);

    const papaEmail = `papa${Date.now()}@example.com`;
    const res = await invite(mama.token, family.id, papaEmail.toUpperCase());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: papaEmail });
    expect(JSON.stringify(res.body)).not.toMatch(/code/i); // コードは応答に含めない
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(papaEmail);
    const code = lastCode();

    // 招待一覧（コードは含めない）
    const pending = await api()
      .get(`/api/v1/families/${family.id}/invites`)
      .set(auth(mama.token))
      .expect(200);
    expect(pending.body).toMatchObject([{ email: papaEmail }]);
    expect(JSON.stringify(pending.body)).not.toContain(code);

    // 招待されたアドレスで登録 → 確認 → 参加（入力の揺れも許容）
    const papa = await signup('パパ', papaEmail);
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4, 8)}-${code.slice(8)}`;
    const preview = await api()
      .post('/api/v1/invites/preview')
      .set(auth(papa.token))
      .send({ code: typed })
      .expect(200);
    expect(preview.body).toMatchObject({
      familyName: 'ママの家族',
      inviterName: 'ママ',
    });
    const accepted = await api()
      .post('/api/v1/invites/accept')
      .set(auth(papa.token))
      .send({ code: typed })
      .expect(200);
    expect(accepted.body).toEqual({ familyId: family.id });

    // 空だった自分の家族は削除され、招待先だけに所属する
    const papaFamilies = await families(papa.token);
    expect(papaFamilies.map((f) => f.id)).toEqual([family.id]);
    expect(papaFamilies[0].myRole).toBe('MEMBER');
    expect(papaFamilies[0].members.map((m) => m.name)).toEqual([
      'ママ',
      'パパ',
    ]);

    const children = await api()
      .get('/api/v1/children')
      .set(auth(papa.token))
      .expect(200);
    expect((children.body as { name: string }[]).map((c) => c.name)).toEqual([
      'たろう',
    ]);

    // 使用済みのコードは再利用できない
    await api()
      .post('/api/v1/invites/accept')
      .set(auth(papa.token))
      .send({ code })
      .expect(404);
  });

  it('only the invited address can use the code', async () => {
    const mama = await signup('ママ');
    const [family] = await families(mama.token);
    const papaEmail = `papa${Date.now()}@example.com`;
    await invite(mama.token, family.id, papaEmail).expect(201);
    const code = lastCode();

    const stranger = await signup('他人');
    for (const path of ['preview', 'accept']) {
      await api()
        .post(`/api/v1/invites/${path}`)
        .set(auth(stranger.token))
        .send({ code })
        .expect(404);
    }
    expect((await families(stranger.token)).map((f) => f.id)).not.toContain(
      family.id,
    );
    // 招待者本人も使えない
    await api()
      .post('/api/v1/invites/accept')
      .set(auth(mama.token))
      .send({ code })
      .expect(404);
    // 認証なしは 401
    await api().post('/api/v1/invites/accept').send({ code }).expect(401);
  });

  it('rejects expired, revoked, replaced and malformed codes the same way', async () => {
    const mama = await signup('ママ');
    const [family] = await families(mama.token);
    const papaEmail = `papa${Date.now()}@example.com`;
    const papa = await signup('パパ', papaEmail);
    const accept = (code: string) =>
      api().post('/api/v1/invites/accept').set(auth(papa.token)).send({ code });

    // 期限切れ
    await invite(mama.token, family.id, papaEmail).expect(201);
    const expired = lastCode();
    await prisma.familyInvite.updateMany({
      where: { familyId: family.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await accept(expired).expect(404);

    // 同じ宛先に再送すると古い招待は無効
    await invite(mama.token, family.id, papaEmail).expect(201);
    const first = lastCode();
    await invite(mama.token, family.id, papaEmail).expect(201);
    const second = lastCode();
    await accept(first).expect(404);

    // 取り消し
    const [pending] = (
      await api()
        .get(`/api/v1/families/${family.id}/invites`)
        .set(auth(mama.token))
        .expect(200)
    ).body as { id: string }[];
    await api()
      .delete(`/api/v1/families/${family.id}/invites/${pending.id}`)
      .set(auth(mama.token))
      .expect(204);
    await accept(second).expect(404);

    // 形式違い・存在しない
    await accept('not-a-code').expect(404);
    await accept('2222-2222-22').expect(404);
    await api()
      .post('/api/v1/invites/accept')
      .set(auth(papa.token))
      .send({})
      .expect(400);
  });

  it('keeps the invitee family when it has children', async () => {
    const mama = await signup('ママ');
    const [mamaFamily] = await families(mama.token);
    const grandmaEmail = `grandma${Date.now()}@example.com`;
    const grandma = await signup('ばあば', grandmaEmail);
    await api()
      .post('/api/v1/children')
      .set(auth(grandma.token))
      .send({ name: 'いとこ', birthDate: '2024-01-01' })
      .expect(201);

    await invite(mama.token, mamaFamily.id, grandmaEmail).expect(201);
    await api()
      .post('/api/v1/invites/accept')
      .set(auth(grandma.token))
      .send({ code: lastCode() })
      .expect(200);
    expect(await families(grandma.token)).toHaveLength(2);
  });

  it('does not keep the invite when the mail cannot be sent', async () => {
    const mama = await signup('ママ');
    const [family] = await families(mama.token);
    failNextSend = 'failed';
    await invite(
      mama.token,
      family.id,
      `x-${Date.now()}-${seq++}@example.com`,
    ).expect(503);
    expect(
      await prisma.familyInvite.count({ where: { familyId: family.id } }),
    ).toBe(0);

    // 時間切れは「届いたかもしれない」ので招待を残す（届いたメールのリンクが使えるように）
    failNextSend = 'timeout';
    await invite(
      mama.token,
      family.id,
      `y-${Date.now()}-${seq++}@example.com`,
    ).expect(503);
    expect(
      await prisma.familyInvite.count({ where: { familyId: family.id } }),
    ).toBe(1);
  });

  it('limits invites and rejects inviting existing members', async () => {
    const mama = await signup('ママ');
    const [family] = await families(mama.token);
    for (let i = 0; i < 10; i++) {
      await invite(
        mama.token,
        family.id,
        `many${i}-${Date.now()}@example.com`,
      ).expect(201);
    }
    // IP 単位の制限（1 分 10 回）ではなく、ユーザー単位の上限（1 時間 10 通）を確認する
    app.get(RateLimitStore).clear();
    await invite(mama.token, family.id, 'one-more@example.com').expect(429);
    // 既存メンバーへの招待は上限より先に弾く（クライアントは code で判定する）
    const dup = await invite(mama.token, family.id, mama.email).expect(409);
    expect(dup.body).toMatchObject({ code: 'ALREADY_MEMBER' });
    await invite(mama.token, family.id, 'bad-address').expect(400);
  });

  it("hides other families' invites and members", async () => {
    const mama = await signup('ママ');
    const [family] = await families(mama.token);
    await invite(
      mama.token,
      family.id,
      `x-${Date.now()}-${seq++}@example.com`,
    ).expect(201);
    const other = await signup('他人');
    const h = auth(other.token);
    await invite(
      other.token,
      family.id,
      `y-${Date.now()}-${seq++}@example.com`,
    ).expect(404);
    await api().get(`/api/v1/families/${family.id}/invites`).set(h).expect(404);
    const [pending] = (
      await api()
        .get(`/api/v1/families/${family.id}/invites`)
        .set(auth(mama.token))
    ).body as { id: string }[];
    await api()
      .delete(`/api/v1/families/${family.id}/invites/${pending.id}`)
      .set(h)
      .expect(404);
    await api()
      .delete(`/api/v1/families/${family.id}/members/${mama.id}`)
      .set(h)
      .expect(404);
  });

  it('lets members leave and the owner remove members, but not the owner leave', async () => {
    const mama = await signup('ママ');
    const [family] = await families(mama.token);
    const join = async (name: string) => {
      const email = `${name}${Date.now()}-${seq++}@example.com`;
      const user = await signup(name, email);
      await invite(mama.token, family.id, email).expect(201);
      await api()
        .post('/api/v1/invites/accept')
        .set(auth(user.token))
        .send({ code: lastCode() })
        .expect(200);
      return user;
    };
    const papa = await join('papa');
    const grandpa = await join('grandpa');
    const member = (id: string) =>
      `/api/v1/families/${family.id}/members/${id}`;

    // OWNER は退出できない / MEMBER は他人を削除できない
    await api().delete(member(mama.id)).set(auth(mama.token)).expect(409);
    await api().delete(member(grandpa.id)).set(auth(papa.token)).expect(403);

    // MEMBER の退出 → 新しい空の家族が作られる
    await api().delete(member(papa.id)).set(auth(papa.token)).expect(204);
    const papaFamilies = await families(papa.token);
    expect(papaFamilies).toHaveLength(1);
    expect(papaFamilies[0]).toMatchObject({
      name: 'papaの家族',
      myRole: 'OWNER',
    });

    // OWNER によるメンバー削除 → 以後そのこどもにアクセスできない
    const child = await api()
      .post('/api/v1/children')
      .set(auth(mama.token))
      .send({ name: 'たろう', birthDate: '2026-06-10' })
      .expect(201);
    const childId = (child.body as { id: string }).id;
    await api()
      .get(`/api/v1/children/${childId}/stats/weight`)
      .set(auth(grandpa.token))
      .expect(200);
    await api().delete(member(grandpa.id)).set(auth(mama.token)).expect(204);
    await api()
      .get(`/api/v1/children/${childId}/stats/weight`)
      .set(auth(grandpa.token))
      .expect(404);
    await api().delete(member(grandpa.id)).set(auth(mama.token)).expect(404);
  });

  it('revokes invites sent by a member who is removed', async () => {
    const mama = await signup('ママ');
    const [family] = await families(mama.token);
    const papaEmail = `papa${Date.now()}-${seq++}@example.com`;
    const papa = await signup('パパ', papaEmail);
    await invite(mama.token, family.id, papaEmail).expect(201);
    await api()
      .post('/api/v1/invites/accept')
      .set(auth(papa.token))
      .send({ code: lastCode() })
      .expect(200);

    // パパが自分で管理する別アドレスを招待しておき、外された後に戻ろうとする
    const altEmail = `alt${Date.now()}-${seq++}@example.com`;
    await invite(papa.token, family.id, altEmail).expect(201);
    const altCode = lastCode();
    await api()
      .delete(`/api/v1/families/${family.id}/members/${papa.id}`)
      .set(auth(mama.token))
      .expect(204);
    const alt = await signup('パパ別アカウント', altEmail);
    await api()
      .post('/api/v1/invites/accept')
      .set(auth(alt.token))
      .send({ code: altCode })
      .expect(404);
  });

  it('allows re-sending at the family limit and caps invites per recipient', async () => {
    const mama = await signup('ママ');
    const [family] = await families(mama.token);
    const target = `target${Date.now()}@example.com`;
    await invite(mama.token, family.id, target).expect(201);
    // 家族の有効な招待を上限（10 件）まで埋める（ユーザーごとの送信上限に当たらないよう DB に直接入れる）
    await prisma.familyInvite.createMany({
      data: Array.from({ length: 9 }, (_, i) => ({
        familyId: family.id,
        email: `fill${i}-${Date.now()}@example.com`,
        codeHash: `fill-${family.id}-${i}`,
        expiresAt: new Date(Date.now() + 60_000),
      })),
    });
    await invite(mama.token, family.id, 'new-person@example.com').expect(409);
    app.get(RateLimitStore).clear();
    // 有効な招待が上限でも、同じ宛先への再送は入れ替わりなので送れる
    await invite(mama.token, family.id, target).expect(201);
    // 同じ家族から同じ宛先へは 24 時間で 3 通まで
    await invite(mama.token, family.id, target).expect(201);
    const res = await invite(mama.token, family.id, target).expect(429);
    expect(res.body).toMatchObject({ code: 'INVITE_LIMIT' });
    // 別の（既存アカウントの）家族からは送れる（ある家族が上限を使い切って他の家族の招待を妨害できない）
    const other = await signup('他人');
    await prisma.user.update({
      where: { id: other.id },
      data: { createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
    });
    const [otherFamily] = await families(other.token);
    await invite(other.token, otherFamily.id, target).expect(201);
  });

  it('keeps exactly one usable invite when two are sent at once', async () => {
    const mama = await signup('ママ');
    const [family] = await families(mama.token);
    const papaEmail = `papa${Date.now()}-${seq++}@example.com`;
    const papa = await signup('パパ', papaEmail);
    await Promise.all([
      invite(mama.token, family.id, papaEmail).expect(201),
      invite(mama.token, family.id, papaEmail).expect(201),
    ]);
    const codes = sent.slice(-2).map((m) => /#([2-9A-Z]{10})/.exec(m.text)![1]);
    const statuses = await Promise.all(
      codes.map(async (code) => {
        const r = await api()
          .post('/api/v1/invites/preview')
          .set(auth(papa.token))
          .send({ code });
        return r.status;
      }),
    );
    expect(statuses.sort()).toEqual([200, 404]);
  });

  it('throwaway accounts cannot block an established family from inviting', async () => {
    const target = `blocked${Date.now()}@example.com`;
    // 作りたてのアカウント 2 つから同じ宛先へ 3 通ずつ → 新規アカウント枠（3 通）で止まる
    for (const name of ['捨て1', '捨て2']) {
      const spammer = await signup(name);
      const [f] = await families(spammer.token);
      for (let i = 0; i < 3; i++) {
        const res = await invite(spammer.token, f.id, target);
        if (res.status !== 201) {
          expect(res.body).toMatchObject({ code: 'INVITE_LIMIT' });
        }
      }
      app.get(RateLimitStore).clear();
    }
    expect(await prisma.familyInvite.count({ where: { email: target } })).toBe(
      3,
    );

    // 作成から 1 日以上経ったアカウントの家族は、変わらず招待できる
    const mama = await signup('ママ');
    await prisma.user.update({
      where: { id: mama.id },
      data: { createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
    });
    const [family] = await families(mama.token);
    await invite(mama.token, family.id, target).expect(201);
  });
});
