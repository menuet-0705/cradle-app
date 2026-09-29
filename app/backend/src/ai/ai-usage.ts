import {
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AiUsageKind } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * AI 機能の利用回数の上限。機能（食事の提案・グラフのコメント）ごとに別の枠で数える。
 * 利用者・全体の試行は ai_usages で数える（こどもの削除・作り直しでは戻らない）
 */
const LIMITS: Record<
  AiUsageKind,
  { user: number; newAccount: number; global: number }
> = {
  // 利用者 1 人の 1 日の試行 / 作成から 1 日以内のアカウント（使い捨てアカウントで全体の上限を
  // 使い切らせない）/ 全利用者の 1 日の試行（費用が青天井にならないための最後の安全装置）
  MEAL_SUGGESTION: { user: 20, newAccount: 6, global: 1_000 },
  CHART_COMMENT: { user: 20, newAccount: 6, global: 2_000 },
};
const NEW_ACCOUNT_MS = 24 * 60 * 60 * 1000;

/**
 * 生成中の行がこの時間を過ぎても残っていたら、強制終了で残ったものとみなす
 * （関数の制限時間 60 秒より十分長く）
 */
export const PENDING_STALE_MS = 2 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** JST の 0:00 */
export const startOfJstDay = (now: Date) =>
  new Date(
    Math.floor((+now + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS,
  );

/** 利用者の今日（JST）の試行の残り。予約した行を含めて数えたあとなら、負の値は上限超過 */
export async function userAttemptsLeft(
  prisma: PrismaService,
  kind: AiUsageKind,
  userId: string,
  now: Date,
): Promise<number> {
  const [attempts, user] = await Promise.all([
    prisma.aiUsage.count({
      where: { kind, userId, createdAt: { gte: startOfJstDay(now) } },
    }),
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { createdAt: true },
    }),
  ]);
  const limit =
    +now - +user.createdAt < NEW_ACCOUNT_MS
      ? LIMITS[kind].newAccount
      : LIMITS[kind].user;
  return limit - attempts;
}

/** 全利用者の今日（JST）の試行が上限を超えたか（予約した行を含めて数えたあとに呼ぶ） */
export async function overGlobalLimit(
  prisma: PrismaService,
  kind: AiUsageKind,
  now: Date,
): Promise<boolean> {
  const attempts = await prisma.aiUsage.count({
    where: { kind, createdAt: { gte: startOfJstDay(now) } },
  });
  return attempts > LIMITS[kind].global;
}

export const dailyLimitReached = (message: string) =>
  new HttpException(
    { message, code: 'DAILY_LIMIT' },
    HttpStatus.TOO_MANY_REQUESTS,
  );

export const aiBusy = () =>
  new ServiceUnavailableException({ message: 'AI is busy', code: 'AI_BUSY' });
