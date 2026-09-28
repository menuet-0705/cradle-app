import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import type { Prisma } from '../generated/prisma/client.js';
import { MAILER, type Mailer } from '../mail/mailer.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AI_CONSENT_VERSION } from './ai-consent.js';
import {
  generateInviteCode,
  hashInviteCode,
  normalizeInviteCode,
} from './invite-code.js';
import { buildInviteMail } from './invite-mail.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const INVITE_TTL_MS = 72 * HOUR_MS;
// スパム・迷惑メールの踏み台にされないための上限。
// 上限自体が「他人の招待を妨害する手段」にならないよう、家族ごと・作りたてのアカウントごとに分けて数える
const MAX_ACTIVE_INVITES_PER_FAMILY = 10;
const MAX_INVITES_PER_USER_PER_HOUR = 10;
// 同じ家族から同じ宛先へ（再送は 3 通まで）
const MAX_INVITES_PER_FAMILY_RECIPIENT_PER_DAY = 3;
// 全家族から同じ宛先へ（1 つの家族が使い切れないよう、家族ごとの上限より大きくする）。
// 作成から 1 日以内のアカウントの分は別枠で数え、使い捨てアカウントで既存の家族の招待を止められないようにする
const MAX_INVITES_PER_RECIPIENT_PER_DAY = 10;
const MAX_NEW_ACCOUNT_INVITES_PER_RECIPIENT_PER_DAY = 3;
// 作成から 1 日以内のアカウントが送る招待の合計（使い捨てアカウントでの大量送信対策。
// 既存のアカウントはこの枠を使わないので、枠を使い切られても通常の利用者は影響を受けない）
const MAX_INVITES_FROM_NEW_ACCOUNTS_PER_DAY = 200;
const TX_OPTIONS = { maxWait: 5000, timeout: 5000 };

/** エラー本文。クライアントは message ではなく code で判定する */
const body = (code: string, message: string) => ({ code, message });

// 無効・期限切れ・使用済み・取り消し済み・宛先違いを区別しない（推測の手がかりを与えない）
const invalidInvite = () =>
  new NotFoundException(body('INVALID_INVITE', 'Invalid invite'));
const tooManyInvites = () =>
  new HttpException(
    body('INVITE_LIMIT', 'Too many invites'),
    HttpStatus.TOO_MANY_REQUESTS,
  );

/**
 * 再試行すれば成功しうるトランザクションのエラー。
 * デッドロック・直列化の失敗（生 SQL では P2010 に包まれて返る）と、
 * 参加と同時に家族が削除された場合の外部キー違反（P2003）
 */
function isRetryableTxError(e: unknown): boolean {
  const { code, message, meta } = e as {
    code?: unknown;
    message?: unknown;
    meta?: { driverAdapterError?: unknown };
  };
  if (code === 'P2034' || code === 'P2003') return true;
  if (code !== 'P2010') return false;
  const detail = `${String(message)} ${String(meta?.driverAdapterError)}`;
  return /TransactionWriteConflict|40P01|40001/.test(detail);
}

const activeInvite = (now: Date) => ({
  usedAt: null,
  revokedAt: null,
  expiresAt: { gt: now },
});

@Injectable()
export class FamiliesService {
  private readonly logger = new Logger(FamiliesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 所属する家族とメンバー */
  async list(userId: string) {
    const memberships = await this.prisma.familyMember.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        family: {
          select: {
            id: true,
            name: true,
            aiConsentAt: true,
            aiConsentVersion: true,
            members: {
              orderBy: { createdAt: 'asc' },
              select: {
                role: true,
                createdAt: true,
                user: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });
    return memberships.map(({ role, family }) => ({
      id: family.id,
      name: family.name,
      myRole: role,
      // 同意の内容を変えたら版を上げ、古い版の同意は無効として扱う
      aiEnabled:
        family.aiConsentAt != null &&
        family.aiConsentVersion === AI_CONSENT_VERSION,
      members: family.members.map((m) => ({
        userId: m.user.id,
        name: m.user.name,
        role: m.role,
        joinedAt: m.createdAt,
      })),
    }));
  }

  async createInvite(userId: string, familyId: string, email: string) {
    const mail = this.config.mail;
    if (!mail) {
      throw new ServiceUnavailableException(
        body('MAIL_UNAVAILABLE', 'Mail is not configured'),
      );
    }
    const { family, user: inviter } = await this.membership(userId, familyId);

    const code = generateInviteCode();
    // 上限の確認と作成を同時リクエストで追い越されないよう、ロックを取って 1 件ずつ行う
    // （作成は低頻度なので全体で 1 つのロックで十分。メール送信はロックの外で行う）
    const invite = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('family_invites:create'))`;

      const alreadyMember = await tx.familyMember.findFirst({
        where: { familyId, user: { email } },
        select: { userId: true },
      });
      if (alreadyMember) {
        throw new ConflictException(body('ALREADY_MEMBER', 'Already a member'));
      }

      const now = Date.now();
      const sentByUser = await tx.familyInvite.count({
        where: {
          createdById: userId,
          createdAt: { gt: new Date(now - HOUR_MS) },
        },
      });
      const since = new Date(now - DAY_MS);
      const isNewAccount = inviter.createdAt > since;
      const sentToRecipient = await tx.familyInvite.count({
        where: {
          email,
          createdAt: { gt: since },
          createdBy: {
            createdAt: isNewAccount ? { gt: since } : { lte: since },
          },
        },
      });
      const sentFromFamily = await tx.familyInvite.count({
        where: { familyId, email, createdAt: { gt: since } },
      });
      if (
        sentByUser >= MAX_INVITES_PER_USER_PER_HOUR ||
        sentFromFamily >= MAX_INVITES_PER_FAMILY_RECIPIENT_PER_DAY ||
        sentToRecipient >=
          (isNewAccount
            ? MAX_NEW_ACCOUNT_INVITES_PER_RECIPIENT_PER_DAY
            : MAX_INVITES_PER_RECIPIENT_PER_DAY)
      ) {
        throw tooManyInvites();
      }
      if (isNewAccount) {
        const sentByNewAccounts = await tx.familyInvite.count({
          where: {
            createdAt: { gt: since },
            createdBy: { createdAt: { gt: since } },
          },
        });
        if (sentByNewAccounts >= MAX_INVITES_FROM_NEW_ACCOUNTS_PER_DAY) {
          // 大量登録による悪用の兆候なので気づけるようにする（宛先などの個人情報は出さない）
          this.logger.warn('Invite limit for new accounts reached');
          throw tooManyInvites();
        }
      }
      // 同じ宛先への再送は古い招待と入れ替わるので数えない
      const active = await tx.familyInvite.count({
        where: {
          familyId,
          email: { not: email },
          ...activeInvite(new Date(now)),
        },
      });
      if (active >= MAX_ACTIVE_INVITES_PER_FAMILY) {
        throw new ConflictException(
          body('TOO_MANY_PENDING', 'Too many pending invites'),
        );
      }

      return tx.familyInvite.create({
        data: {
          familyId,
          createdById: userId,
          email,
          codeHash: hashInviteCode(code),
          expiresAt: new Date(now + INVITE_TTL_MS),
        },
        select: { id: true, email: true, expiresAt: true, createdAt: true },
      });
    }, TX_OPTIONS);

    try {
      await this.mailer.send(
        buildInviteMail({
          to: email,
          inviterName: inviter.name,
          familyName: family.name,
          code,
          appUrl: mail.appUrl,
          expiresAt: invite.expiresAt,
        }),
      );
    } catch (e) {
      // 届いていない招待は残さない（古い招待はまだ有効なまま）
      await this.prisma.familyInvite.delete({ where: { id: invite.id } });
      throw e;
    }

    // 同じ宛先へのこれより古い招待を無効にする（最新のメールだけが使える）。
    // 「これより古い」に限ることで、ほぼ同時に送った 2 通が互いを無効にしない
    await this.prisma.familyInvite.updateMany({
      where: {
        familyId,
        email,
        // 同じミリ秒に作られた場合は ID の大小で前後を決める
        OR: [
          { createdAt: { lt: invite.createdAt } },
          { createdAt: invite.createdAt, id: { lt: invite.id } },
        ],
        usedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    return invite;
  }

  async listInvites(userId: string, familyId: string) {
    await this.membership(userId, familyId);
    return this.prisma.familyInvite.findMany({
      where: { familyId, ...activeInvite(new Date()) },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        expiresAt: true,
        createdAt: true,
        createdBy: { select: { id: true, name: true } },
      },
    });
  }

  async revokeInvite(userId: string, familyId: string, inviteId: string) {
    await this.membership(userId, familyId);
    const { count } = await this.prisma.familyInvite.updateMany({
      where: { id: inviteId, familyId, usedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) {
      throw new NotFoundException(body('INVITE_NOT_FOUND', 'Invite not found'));
    }
  }

  /** 参加前の確認用。本人宛ての有効な招待のみ */
  async preview(userId: string, rawCode: string) {
    const invite = await this.findUsableInvite(this.prisma, userId, rawCode);
    return {
      familyName: invite.family.name,
      inviterName: invite.createdBy?.name ?? null,
      expiresAt: invite.expiresAt,
    };
  }

  /**
   * 招待を使って家族に参加する。
   * 自分の家族が「こども 0 人・自分だけ」なら削除して、招待先の家族に合流する
   */
  async accept(userId: string, rawCode: string) {
    // 互いの家族への同時参加などで起きる衝突は 1 回だけ自動で再試行する
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.acceptInTransaction(userId, rawCode);
      } catch (e) {
        if (!isRetryableTxError(e)) throw e;
        // 招待は使用済みになっていない（ロールバック済み）ので、利用者にも再試行を促せる
        if (attempt >= 2) {
          throw new ConflictException(body('RETRY', 'Please try again'));
        }
      }
    }
  }

  private acceptInTransaction(userId: string, rawCode: string) {
    return this.prisma.$transaction(async (tx) => {
      const invite = await this.findUsableInvite(tx, userId, rawCode);
      const now = new Date();
      // 同じ招待の同時使用に備え、未使用の場合のみ使用済みにする
      const { count } = await tx.familyInvite.updateMany({
        where: { id: invite.id, ...activeInvite(now) },
        data: { usedAt: now, usedById: userId },
      });
      if (count === 0) throw invalidInvite();

      await tx.familyMember.upsert({
        where: { familyId_userId: { familyId: invite.familyId, userId } },
        create: { familyId: invite.familyId, userId, role: 'MEMBER' },
        update: {},
      });

      // 削除候補（自分が管理者の他の家族）の行をロックしてから、空かどうかを判定し直す。
      // 同時に誰かが参加・こどもを登録しても、その行は外部キーの確認でロック解除を待つため、
      // 「空だと判定した後に追加されたメンバー・こども」を巻き込んで消すことはない
      const candidates = await tx.$queryRaw<{ id: string }[]>`
        SELECT f.id FROM ${this.prisma.schema}.families f
          JOIN ${this.prisma.schema}.family_members m ON m.family_id = f.id
         WHERE m.user_id = ${userId}::uuid
           AND m.role = 'OWNER'
           AND f.id <> ${invite.familyId}::uuid
         FOR UPDATE OF f`;
      if (candidates.length > 0) {
        await tx.family.deleteMany({
          where: {
            id: { in: candidates.map((c) => c.id) },
            children: { none: {} },
            members: { every: { userId } },
          },
        });
      }
      return { familyId: invite.familyId };
    }, TX_OPTIONS);
  }

  /**
   * メンバーの削除（OWNER のみ）、または自分の退出（MEMBER のみ）。
   * 所属する家族がなくなった人には、新しい空の家族を作る（こども登録ができなくならないように）
   */
  async removeMember(userId: string, familyId: string, targetUserId: string) {
    const { role } = await this.membership(userId, familyId);
    const isSelf = userId === targetUserId;
    if (isSelf && role === 'OWNER') {
      throw new ConflictException(
        body('OWNER_CANNOT_LEAVE', 'Owner cannot leave the family'),
      );
    }
    if (!isSelf && role !== 'OWNER') {
      throw new ForbiddenException(
        body('OWNER_ONLY', 'Only the owner can remove members'),
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.familyMember.deleteMany({
        where: { familyId, userId: targetUserId, role: 'MEMBER' },
      });
      if (count === 0) {
        throw new NotFoundException(
          body('MEMBER_NOT_FOUND', 'Member not found'),
        );
      }

      // 外された人が出した招待で戻ってこられないよう、その人の招待も無効にする
      await tx.familyInvite.updateMany({
        where: {
          familyId,
          createdById: targetUserId,
          usedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });

      const remaining = await tx.familyMember.count({
        where: { userId: targetUserId },
      });
      if (remaining === 0) {
        const target = await tx.user.findUniqueOrThrow({
          where: { id: targetUserId },
          select: { name: true },
        });
        await tx.family.create({
          data: {
            name: `${target.name}の家族`,
            members: { create: { userId: targetUserId, role: 'OWNER' } },
          },
        });
      }
    }, TX_OPTIONS);
  }

  /**
   * AI 機能への同意・取り消し（管理者のみ）。
   * こどもの記録を外国（米国）の事業者に送る判断なので、家族の管理者に限る
   */
  async setAiConsent(
    userId: string,
    familyId: string,
    consent: { version: number } | null,
  ) {
    const { role } = await this.membership(userId, familyId);
    if (role !== 'OWNER') {
      throw new ForbiddenException(
        body('OWNER_ONLY', 'Only the owner can change AI settings'),
      );
    }
    if (consent && consent.version !== AI_CONSENT_VERSION) {
      // 画面に出した説明と、サーバーが想定する同意の内容が食い違っている（古いアプリなど）
      throw new ConflictException(
        body('CONSENT_OUTDATED', 'Consent version is outdated'),
      );
    }
    await this.prisma.$transaction([
      this.prisma.family.update({
        where: { id: familyId },
        data: consent
          ? {
              aiConsentAt: new Date(),
              aiConsentVersion: consent.version,
              aiConsentById: userId,
            }
          : { aiConsentAt: null, aiConsentVersion: null, aiConsentById: null },
      }),
      // 取り消したら、作成中のレポートも完成させない（結果を保存せず、メールも送らない）
      ...(consent
        ? []
        : [
            this.prisma.weeklyReport.updateMany({
              where: { status: 'PENDING', child: { familyId } },
              data: { status: 'FAILED' },
            }),
          ]),
    ]);
    return { aiEnabled: consent != null };
  }

  /** 所属していなければ 404（他家族の存在を推測させない） */
  private async membership(userId: string, familyId: string) {
    const m = await this.prisma.familyMember.findUnique({
      where: { familyId_userId: { familyId, userId } },
      select: {
        role: true,
        family: { select: { name: true } },
        user: { select: { name: true, createdAt: true } },
      },
    });
    if (!m) {
      throw new NotFoundException(body('FAMILY_NOT_FOUND', 'Family not found'));
    }
    return m;
  }

  private async findUsableInvite(
    db: Prisma.TransactionClient,
    userId: string,
    rawCode: string,
  ) {
    const code = normalizeInviteCode(rawCode);
    if (!code) throw invalidInvite();
    // トランザクション内でも使うので並列にしない（1 接続上で順に実行する）
    const invite = await db.familyInvite.findUnique({
      where: { codeHash: hashInviteCode(code) },
      select: {
        id: true,
        familyId: true,
        email: true,
        expiresAt: true,
        usedAt: true,
        revokedAt: true,
        family: { select: { name: true } },
        createdBy: { select: { name: true } },
      },
    });
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (
      !invite ||
      !user ||
      invite.email !== user.email ||
      invite.usedAt ||
      invite.revokedAt ||
      invite.expiresAt <= new Date()
    ) {
      throw invalidInvite();
    }
    return invite;
  }
}
