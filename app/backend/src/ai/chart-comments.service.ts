import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ChildrenService } from '../children/children.service.js';
import { Prisma, type ChartKind } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RecordsService } from '../records/records.service.js';
import { AI_MODEL, isAiConfigured, type AiModel } from './ai-model.js';
import {
  aiBusy,
  dailyLimitReached,
  overGlobalLimit,
  PENDING_STALE_MS,
  startOfJstDay,
  userAttemptsLeft,
} from './ai-usage.js';
import { writeChartComment, type ChartCommentInput } from './chart-comment.js';
import { ageInMonths } from './prompt.js';

/**
 * こども × グラフごとの 1 日（JST）の試行（失敗も含む）の上限。
 * コメントは 1 日 1 件なので、失敗したときの作り直しの分だけ余裕を持たせる。
 * 利用者ごと・全体の上限は ai_usages で数える（食事の提案とは別の枠。ai-usage.ts）
 */
// （日本以外の地域では、現地で日付が変わっても JST の日付が変わるまで回数は戻らない。仕様上の割り切り）
export const CHART_COMMENT_DAILY_ATTEMPTS = 3;
// 失敗した直後は自動で作り直さない（タブの行き来などで失敗を繰り返さない）
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
// 体重のグラフのコメントに使う期間
const WEIGHT_LOOKBACK_DAYS = 90;
// ミルクのグラフと同じ日数（アプリの milkChartDays）
const MILK_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const TX_OPTIONS = { maxWait: 5000, timeout: 5000 };

const commentSelect = {
  id: true,
  content: true,
  createdAt: true,
} as const satisfies Prisma.ChartCommentSelect;

/** tz（検証済みの IANA 名）での日付（YYYY-MM-DD） */
const localDate = (at: Date, tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at);

/** YYYY-MM-DD の日付に日数を足す */
const addDays = (date: string, days: number) =>
  new Date(+new Date(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

/** 今日（tz）のコメントの作成状況と、そのグラフの記録が今日あるか */
interface Today {
  /** 成功した、または作成中（強制終了で残った古いものは除く）のコメントの数 */
  live: number;
  /**
   * 失敗も含む試行の数。端末から送られる tz ではなく JST の日で数える
   * （tz を変えて 1 日の区切りをずらし、上限を回避させない）
   */
  attempts: number;
  generating: boolean;
  lastFailedAt: Date | null;
  hasRecord: boolean;
}

/**
 * グラフごとの AI のコメント。
 * こども × グラフで 1 日 1 件。そのグラフの記録が今日あれば、その日最初に開いたときに作る（家族で共有）。
 * 回数は食事の提案とは別の枠で数える
 */
@Injectable()
export class ChartCommentsService {
  private readonly logger = new Logger(ChartCommentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly children: ChildrenService,
    private readonly records: RecordsService,
    @Inject(AI_MODEL) private readonly model: AiModel,
  ) {}

  /** 最新のコメントと、今作るべきか（アプリは needsUpdate なら作成を依頼する） */
  async state(userId: string, childId: string, chart: ChartKind, tz: string) {
    await this.children.assertAccess(userId, childId);
    return this.stateOf(userId, childId, chart, tz, new Date());
  }

  async create(userId: string, childId: string, chart: ChartKind, tz: string) {
    await this.children.assertAccess(userId, childId);
    if (!isAiConfigured(this.model)) {
      throw new ServiceUnavailableException('AI is not configured');
    }
    const now = new Date();

    // 確認と予約を、こども × グラフごとに 1 件ずつ行う（家族が同時に開いても 1 回だけ作る）
    const reserved = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('chart_comments:' || ${childId} || ':' || ${chart}))`;
      const today = await this.today(tx, childId, chart, tz, now);
      // 今日の記録がない・今日のコメントがある（作成中を含む）・失敗した直後は作らない
      if (!today.hasRecord || today.live > 0 || coolingDown(today, now)) {
        return null;
      }
      if (today.attempts >= CHART_COMMENT_DAILY_ATTEMPTS) {
        throw dailyLimitReached('Daily chart comment limit reached');
      }
      // 利用者・全体の回数は、こどもを削除しても消えない ai_usages に残す
      const [comment, usage] = await Promise.all([
        tx.chartComment.create({
          data: { childId, chart, model: this.model.name, createdById: userId },
          select: { id: true },
        }),
        tx.aiUsage.create({
          data: { kind: 'CHART_COMMENT', userId },
          select: { id: true },
        }),
      ]);
      return { commentId: comment.id, usageId: usage.id };
    }, TX_OPTIONS);
    if (!reserved) return this.stateOf(userId, childId, chart, tz, now);
    const reservedId = reserved.commentId;

    // 予約した行を含めて数える（別のこども・別の利用者と同時に依頼されても上限を超えない）
    const [userLeft, overGlobal] = await Promise.all([
      userAttemptsLeft(this.prisma, 'CHART_COMMENT', userId, now),
      overGlobalLimit(this.prisma, 'CHART_COMMENT', now),
    ]);
    if (userLeft < 0 || overGlobal) {
      // LLM は呼んでいないので試行には数えない
      await this.prisma
        .$transaction([
          this.prisma.chartComment.delete({ where: { id: reservedId } }),
          this.prisma.aiUsage.delete({ where: { id: reserved.usageId } }),
        ])
        .catch(() => this.logger.error('Failed to discard a chart comment'));
      if (userLeft < 0) {
        throw dailyLimitReached('Daily chart comment limit reached');
      }
      this.logger.warn('Global daily chart comment limit reached');
      throw aiBusy();
    }

    try {
      const input = await this.chartInput(childId, chart, tz, now);
      const content = await writeChartComment(this.model, input);
      await this.prisma.chartComment.update({
        where: { id: reservedId },
        data: { content },
      });
    } catch (e) {
      // こどもが削除された（予約した行も消えている）
      if (e instanceof NotFoundException) throw e;
      // 失敗も試行として残す（成功には数えない）
      await this.prisma.chartComment
        .update({ where: { id: reservedId }, data: { failedAt: new Date() } })
        .catch(() => this.logger.error('Failed to mark a chart comment'));
      throw e;
    }
    return this.stateOf(userId, childId, chart, tz, now);
  }

  private async stateOf(
    userId: string,
    childId: string,
    chart: ChartKind,
    tz: string,
    now: Date,
  ) {
    const enabled = isAiConfigured(this.model);
    const [today, comment, userLeft] = await Promise.all([
      this.today(this.prisma, childId, chart, tz, now),
      this.prisma.chartComment.findFirst({
        // content が null の行は生成中か、生成に失敗したもの
        where: { childId, chart, content: { not: Prisma.DbNull } },
        select: commentSelect,
        orderBy: { createdAt: 'desc' },
      }),
      userAttemptsLeft(this.prisma, 'CHART_COMMENT', userId, now),
    ]);
    // 今日の記録があり、今日のコメントがまだない
    const due = enabled && today.hasRecord && today.live === 0;
    // こども × グラフの試行か、利用者の 1 日の上限に達した（開くたびに作成を依頼させない）
    const limitReached =
      due && (today.attempts >= CHART_COMMENT_DAILY_ATTEMPTS || userLeft <= 0);
    // 失敗した直後で、少し待てば作れる
    const retryLater = due && !limitReached && coolingDown(today, now);
    return {
      comment,
      needsUpdate: due && !limitReached && !retryLater,
      generating: today.generating,
      retryLater,
      limitReached,
      enabled,
    };
  }

  /** 今日（tz の日付）のコメントの作成状況と、そのグラフの記録が今日あるか（1 回の問い合わせ） */
  private async today(
    db: Prisma.TransactionClient,
    childId: string,
    chart: ChartKind,
    tz: string,
    now: Date,
  ): Promise<Today> {
    const schema = this.prisma.schema;
    const nowAt = now.toISOString();
    const staleAt = new Date(+now - PENDING_STALE_MS).toISOString();
    const [row] = await db.$queryRaw<
      {
        live: bigint;
        attempts: bigint;
        generating: bigint;
        lastFailedAt: Date | null;
        hasRecord: boolean;
      }[]
    >`
      SELECT
        count(*) FILTER (
          WHERE (c.created_at AT TIME ZONE ${tz})::date
              = (${nowAt}::timestamptz AT TIME ZONE ${tz})::date
            AND (c.content IS NOT NULL
                 OR (c.failed_at IS NULL AND c.created_at > ${staleAt}::timestamptz))
        ) AS "live",
        count(*) FILTER (
          WHERE c.created_at >= ${startOfJstDay(now).toISOString()}::timestamptz
        ) AS "attempts",
        count(*) FILTER (
          WHERE c.content IS NULL AND c.failed_at IS NULL
            AND c.created_at > ${staleAt}::timestamptz
        ) AS "generating",
        max(c.failed_at) AS "lastFailedAt",
        EXISTS (
          SELECT 1
            FROM ${schema}.records r
           WHERE r.child_id = ${childId}::uuid
             AND r.type = CAST(${chart} AS ${schema}."RecordType")
             -- インデックス (child_id, type, started_at) を使うための粗い範囲
             AND r.started_at >= ${nowAt}::timestamptz - interval '2 days'
             AND (r.started_at AT TIME ZONE ${tz})::date
               = (${nowAt}::timestamptz AT TIME ZONE ${tz})::date
        ) AS "hasRecord"
        FROM ${schema}.chart_comments c
       WHERE c.child_id = ${childId}::uuid
         AND c.chart = CAST(${chart} AS ${schema}."ChartKind")
         -- tz の今日・JST の今日・失敗直後の待ち時間をすべて含む範囲（試行は tz に依存させない）
         AND c.created_at >= ${nowAt}::timestamptz - interval '2 days'`;
    return {
      live: Number(row.live),
      attempts: Number(row.attempts),
      generating: Number(row.generating) > 0,
      lastFailedAt: row.lastFailedAt,
      hasRecord: row.hasRecord,
    };
  }

  /** AI に渡すグラフのデータ。名前やメモは含めない（月齢・性別と数値だけ） */
  private async chartInput(
    childId: string,
    chart: ChartKind,
    tz: string,
    now: Date,
  ): Promise<ChartCommentInput> {
    const child = await this.prisma.child.findUnique({
      where: { id: childId },
      select: { birthDate: true, sex: true },
    });
    // 確認の後にこどもが削除された
    if (!child) throw new NotFoundException('Child not found');
    const base = {
      ageMonths: ageInMonths(child.birthDate, now),
      sex: child.sex,
    };
    if (chart === 'WEIGHT') {
      const rows = await this.prisma.record.findMany({
        where: {
          childId,
          type: 'WEIGHT',
          startedAt: { gte: new Date(+now - WEIGHT_LOOKBACK_DAYS * DAY_MS) },
        },
        select: { startedAt: true, weightG: true },
        orderBy: [{ startedAt: 'asc' }, { createdAt: 'asc' }],
      });
      return {
        ...base,
        chart,
        weights: rows.map((r) => ({
          date: localDate(r.startedAt, tz),
          weightG: r.weightG ?? 0,
        })),
      };
    }
    const today = localDate(now, tz);
    const from = addDays(today, -(MILK_DAYS - 1));
    const totals = new Map(
      (await this.records.milkDailyOf(childId, { from, to: today, tz })).map(
        (d) => [d.date, d],
      ),
    );
    return {
      ...base,
      chart,
      // 記録のない日も 0 として並べる（グラフと同じ）
      days: Array.from({ length: MILK_DAYS }, (_, i) => {
        const date = addDays(from, i);
        const d = totals.get(date);
        return { date, totalMl: d?.totalMl ?? 0, count: d?.count ?? 0 };
      }),
    };
  }
}

const coolingDown = (today: Today, now: Date) =>
  today.lastFailedAt !== null &&
  +now - +today.lastFailedAt < FAILURE_COOLDOWN_MS;
