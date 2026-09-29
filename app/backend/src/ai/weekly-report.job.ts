import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { Prisma } from '../generated/prisma/client.js';
import { MAILER, type Mailer } from '../mail/mailer.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  AI_MODEL,
  isAiConfigured,
  LLM_TIMEOUT_MS,
  type AiModel,
} from './ai-model.js';
import { ageInMonths, redactNames } from './prompt.js';
import { buildReportMail } from './report-mail.js';
import {
  buildWeeklyReportGraph,
  runWeeklyReport,
  type WeeklyReportGraph,
} from './weekly-report.graph.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * HOUR_MS;
const FRIDAY = 5;
const REPORT_HOUR_JST = 17;
// Cron は金曜 17:00〜23:00 JST に毎時実行する（vercel.json）。23:00 の回が最後
const FINAL_RUN_AFTER_MS = 6 * HOUR_MS;

// Vercel の制限時間は 60 秒（関数の起動時間も含むが、run() の中からは測れない）。
// 1 回の実行では「生成」か「通知」のどちらかだけを行い、起動に 10 秒程度かかっても収まるようにする
// 生成: LLM の上限 20 秒 + DB の読み書きの余裕を見て、開始から 40 秒以内に終わるときだけ次を始める
const GENERATION_BUDGET_MS = 40_000;
const DB_MARGIN_MS = 3_000;
// 通知: 1 通の送信は最大 8 秒（mailer.ts）なので、42 秒までに送り始めたものだけ送る（通知は最大 1 回の設計）
const MAIL_DEADLINE_MS = 42_000;
const LLM_CONCURRENCY = 6;
const MAIL_CONCURRENCY = 10;
// 1 回の実行で候補として読むこどもの数（時間内に作れる数より十分多く）
const MAX_CANDIDATES = 200;
const MAX_RECORDS = 2_000;

/** now 以前で直近の「金曜 17:00 JST」（レポート期間の終わり） */
export function reportPeriodEnd(now: Date): Date {
  const jst = new Date(+now + JST_OFFSET_MS);
  const daysSinceFriday = (jst.getUTCDay() - FRIDAY + 7) % 7;
  let end =
    Date.UTC(
      jst.getUTCFullYear(),
      jst.getUTCMonth(),
      jst.getUTCDate() - daysSinceFriday,
      REPORT_HOUR_JST,
    ) - JST_OFFSET_MS;
  if (end > +now) end -= 7 * DAY_MS;
  return new Date(end);
}

export interface WeeklyReportJobResult {
  periodStart: Date;
  periodEnd: Date;
  created: number;
  failed: number;
  /** 時間切れで今回作れなかった数（次の実行で作る。候補の読み込み上限を超える分は含まない） */
  remaining: number;
  notified: number;
}

/**
 * 習慣レポートの作成とメール通知（金曜 17:00〜23:00 JST に Vercel Cron から毎時呼ぶ）。
 * 何度実行しても同じ週のレポートは 1 つ・通知は 1 回だけなので、再実行・重複実行しても安全。
 *
 * 1 回の実行では、次のどちらかだけを行う（制限時間に収めるため）。
 * - 生成: まだレポートがないこどもの分を作る。1 回で作れるのは LLM の応答時間しだいで十数〜数十人分。
 *   作り切れなかった分・失敗した分は次の回で作る
 * - 通知: 作るものが残っていない回（全員分できた次の回）と、最後の回（23:00）に、未通知の分をまとめて送る。
 *   こうすると 1 人あたり原則 1 通にまとまる（最後の回より後に作られた分はない）
 */
@Injectable()
export class WeeklyReportJob {
  private readonly logger = new Logger(WeeklyReportJob.name);
  private readonly graph: WeeklyReportGraph;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AI_MODEL) private readonly model: AiModel,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.graph = buildWeeklyReportGraph(model);
  }

  async run(now = new Date()): Promise<WeeklyReportJobResult> {
    const startedAt = Date.now();
    const elapsed = () => Date.now() - startedAt;
    const periodEnd = reportPeriodEnd(now);
    const periodStart = new Date(+periodEnd - 7 * DAY_MS);
    const result: WeeklyReportJobResult = {
      periodStart,
      periodEnd,
      created: 0,
      failed: 0,
      remaining: 0,
      notified: 0,
    };
    if (!isAiConfigured(this.model)) {
      this.logger.warn('AI is not configured; weekly reports are skipped');
      return result;
    }

    // 金曜 23:00 JST 以降のその日の回が最後（それ以外の日の手動実行では、通常どおり生成してから通知する）
    const sinceEnd = +now - +periodEnd;
    const finalRun = sinceEnd >= FINAL_RUN_AFTER_MS && sinceEnd < DAY_MS;
    const queue = await this.candidates(periodStart, periodEnd);
    if (!finalRun && queue.length > 0) {
      // LLM の応答を待ちきれずに制限時間を超えないよう、残り時間が足りるときだけ次を始める
      const canStart = () =>
        elapsed() + LLM_TIMEOUT_MS + DB_MARGIN_MS <= GENERATION_BUDGET_MS;
      await runConcurrently(LLM_CONCURRENCY, async () => {
        while (queue.length > 0 && canStart()) {
          const childId = queue.shift()!;
          try {
            if (await this.createReport(childId, periodStart, periodEnd)) {
              result.created++;
            }
          } catch (e) {
            // 1 人の失敗で全体を止めない。作れなかった分は次の回で再試行される
            this.logger.error(
              `Weekly report failed for a child: ${(e as Error).name}`,
            );
            result.failed++;
          }
        }
      });
      result.remaining = queue.length;
      this.logger.log(
        `Weekly reports: created=${result.created} failed=${result.failed} remaining=${result.remaining}`,
      );
      return result;
    }

    // 作るものが残っていない（全員分できた）か、最後の回: 通知だけ行う
    result.remaining = queue.length;
    result.notified = await this.notify(periodEnd, now, elapsed);
    if (queue.length > 0) {
      // この週のレポートを作り切れなかった（処理量の上限。Cron の回数や並列数の見直しが必要）
      this.logger.warn(
        `Weekly reports incomplete on the final run: remaining=${queue.length} notified=${result.notified}`,
      );
    } else {
      this.logger.log(`Weekly report mails: notified=${result.notified}`);
    }
    return result;
  }

  /**
   * 期間内に記録があり、まだレポートがないこども（記録がなければ LLM を呼ばない）。
   * 順番は毎回ランダムにする（失敗し続けるこどもが毎回先頭で時間を使い、他の家族のレポートが作られない状態を防ぐ）
   */
  private async candidates(periodStart: Date, periodEnd: Date) {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT c.id
        FROM ${this.prisma.schema}.children c
       WHERE EXISTS (
               SELECT 1 FROM ${this.prisma.schema}.records r
                WHERE r.child_id = c.id
                  AND r.started_at >= ${periodStart}
                  AND r.started_at < ${periodEnd})
         AND NOT EXISTS (
               SELECT 1 FROM ${this.prisma.schema}.weekly_reports w
                WHERE w.child_id = c.id
                  AND w.period_end = ${periodEnd})
       ORDER BY random()
       LIMIT ${MAX_CANDIDATES}`;
    return rows.map((r) => r.id);
  }

  /** レポートを作る。別の実行が先に作っていたら false */
  private async createReport(
    childId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<boolean> {
    const [child, records, previous] = await Promise.all([
      this.prisma.child.findUniqueOrThrow({
        where: { id: childId },
        select: {
          birthDate: true,
          sex: true,
          // きょうだいの名前もメモに書かれうるので、家族のこども全員の名前を伏せる
          family: { select: { children: { select: { name: true } } } },
        },
      }),
      this.prisma.record.findMany({
        where: { childId, startedAt: { gte: periodStart, lt: periodEnd } },
        select: {
          type: true,
          startedAt: true,
          endedAt: true,
          amountMl: true,
          weightG: true,
          note: true,
        },
        orderBy: { startedAt: 'asc' },
        take: MAX_RECORDS,
      }),
      // 前週のレポート（前週の期間の終わり = 今週の期間の始まり）
      this.prisma.weeklyReport.findUnique({
        where: { childId_periodEnd: { childId, periodEnd: periodStart } },
        select: { summary: true },
      }),
    ]);
    if (records.length === MAX_RECORDS) {
      this.logger.warn('Weekly report records were truncated');
    }
    const { summary, content } = await runWeeklyReport(this.graph, {
      ageMonths: ageInMonths(child.birthDate, periodEnd),
      sex: child.sex,
      periodStart,
      periodEnd,
      // メモに書かれたこどもの名前は外部の LLM に送らない
      records: records.map((r) => ({
        ...r,
        note:
          r.note &&
          redactNames(
            r.note,
            child.family.children.map((c) => c.name),
          ),
      })),
      previousSummary: previous?.summary ?? null,
    });
    try {
      await this.prisma.weeklyReport.create({
        data: {
          childId,
          periodStart,
          periodEnd,
          summary: summary as unknown as Prisma.InputJsonObject,
          content,
          model: this.model.name,
        },
      });
      return true;
    } catch (e) {
      // 同時に動いた別の実行が先に作った（冪等なので問題ない）
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        return false;
      }
      throw e;
    }
  }

  /** 未通知のレポートを「通知済み」にできた分だけ、家族のメンバーに 1 人 1 通で知らせる */
  private async notify(
    periodEnd: Date,
    now: Date,
    elapsed: () => number,
  ): Promise<number> {
    const mail = this.config.mail;
    if (!mail) return 0; // メール未設定の環境ではレポートだけ作る

    // 通知済みにする更新が成功した分だけを送る（重複実行でも二重に送らない。送信失敗は再送しない）
    const claimed = await this.prisma.weeklyReport.updateManyAndReturn({
      where: { periodEnd, notifiedAt: null },
      data: { notifiedAt: now },
      select: { childId: true },
    });
    if (claimed.length === 0) return 0;

    const children = await this.prisma.child.findMany({
      where: { id: { in: claimed.map((r) => r.childId) } },
      select: {
        name: true,
        family: {
          select: {
            members: {
              where: { user: { weeklyReportEmail: true } },
              select: { user: { select: { id: true, email: true } } },
            },
          },
        },
      },
      orderBy: { birthDate: 'asc' },
    });
    const recipients = new Map<string, { email: string; names: string[] }>();
    for (const child of children) {
      for (const { user } of child.family.members) {
        const r = recipients.get(user.id) ?? { email: user.email, names: [] };
        r.names.push(child.name);
        recipients.set(user.id, r);
      }
    }

    const queue = [...recipients.values()];
    let sent = 0;
    await runConcurrently(MAIL_CONCURRENCY, async () => {
      while (queue.length > 0 && elapsed() < MAIL_DEADLINE_MS) {
        const r = queue.shift()!;
        try {
          await this.mailer.send(
            buildReportMail({
              to: r.email,
              childNames: r.names,
              appUrl: mail.appUrl,
            }),
          );
          sent++;
        } catch {
          // 送信側でログ済み（宛先は出さない）。1 通の失敗で他の人への通知を止めない
        }
      }
    });
    if (queue.length > 0) {
      this.logger.warn(
        `Weekly report mail skipped (time limit): ${queue.length} recipients`,
      );
    }
    return sent;
  }
}

/** worker を n 本並べて実行する（各 worker は共有のキューから取り出す） */
async function runConcurrently(n: number, worker: () => Promise<void>) {
  await Promise.all(Array.from({ length: n }, worker));
}
