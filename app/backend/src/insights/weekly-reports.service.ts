import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ChildrenService } from '../children/children.service.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { AI_CONSENT_VERSION, aiEnabledFamily } from '../families/ai-consent.js';
import { Prisma } from '../generated/prisma/client.js';
import { MAILER, type Mailer } from '../mail/mailer.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ageInMonths,
  buildWeeklyReportInput,
  reportPeriod,
  type WeeklyReportInput,
} from './aggregate.js';
import {
  INSIGHTS_MODEL,
  type FetchOptions,
  type InsightsModel,
} from './insights-model.js';
import type { WeeklyReportContent } from './insights.schemas.js';
import { filterUnsafeReport } from './safety.js';
import { buildWeeklyReportMail } from './weekly-report-mail.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// Batch は最大 24 時間で終わる。回収 Cron は 1 日 1 回（最大 59 分ずれる）なので、
// 結果を取りに行った後でも PENDING のままなら、この時間を過ぎたものだけ失敗扱いにする
const PENDING_TIMEOUT_MS = 50 * HOUR_MS;
// 依頼の途中で止まった（batchId がない）行は、この時間を過ぎたら作り直す
const STRANDED_MS = 10 * MINUTE_MS;
// 1 回の Cron で依頼する件数の上限（費用の上限）
const MAX_REPORTS_PER_RUN = 200;
// 処理時間の配分（Vercel の制限時間 60 秒内に収める: 20 + 25 + 10 = 55 秒）。
// 通信 1 回は最大 10 秒（再試行なし）なので、各段階は「残り時間で終わる見込みがなければ新しい通信を始めない」
const CALL_MS = 10_000;
const SUBMIT_BUDGET_MS = 20_000; // 入力の組み立て（通信 1 回分を残して打ち切る）＋ Batch の作成
const COLLECT_BUDGET_MS = 25_000; // 1 つの Batch は通信 2 回（状態の確認・結果の取得）
const NOTIFY_BUDGET_MS = 10_000;
// 画面表示からの回収は、アプリの待ち時間（20 秒）内に終える
const LAZY_CALL_MS = 5_000;
// 画面を開いたときの回収は、同じ Batch をこの間隔より頻繁には問い合わせない（インスタンス単位）
const LAZY_COLLECT_INTERVAL_MS = MINUTE_MS;
// 完成メールの再送は、完成から 7 日以内のものだけ
const NOTIFY_WITHIN_MS = 7 * DAY_MS;
// 食事の提案（健康に関わる生成物）の保存期間
const SUGGESTION_RETENTION_MS = 90 * DAY_MS;

const listSelect = {
  id: true,
  periodStart: true,
  periodEnd: true,
  status: true,
  readyAt: true,
  content: true,
} as const;

@Injectable()
export class WeeklyReportsService {
  private readonly logger = new Logger(WeeklyReportsService.name);
  private readonly lastCheckedAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly children: ChildrenService,
    @Inject(INSIGHTS_MODEL) private readonly model: InsightsModel,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * （毎日の Cron）依頼漏れの再依頼 → 結果の回収 → 完成メール → 古い提案の削除。
   * 1 つの段階が失敗しても（Claude API の障害など）、残りの段階は実行する
   */
  async runDaily(now = new Date()) {
    if (!this.config.ai) return { skipped: true };
    const failed: string[] = [];
    const stage = async <T>(name: string, run: () => Promise<T>) => {
      try {
        return await run();
      } catch (e) {
        failed.push(name);
        this.logger.error(`Daily ${name} failed: ${(e as Error).name}`);
        return undefined;
      }
    };
    // 金曜に依頼できなかった分（失敗・途中停止）は、同じ週のうちに毎日再依頼する
    const submitted = await stage('submit', () =>
      this.submit(now, Date.now() + SUBMIT_BUDGET_MS),
    );
    const collected = await stage('collect', () =>
      this.collect({ deadline: Date.now() + COLLECT_BUDGET_MS }),
    );
    const notified = await stage('notify', () =>
      this.notifyReady(Date.now() + NOTIFY_BUDGET_MS),
    );
    await stage('retention', () =>
      this.prisma.mealSuggestion.deleteMany({
        where: {
          createdAt: { lt: new Date(now.getTime() - SUGGESTION_RETENTION_MS) },
        },
      }),
    );
    return { ...submitted, ...collected, notified, failed };
  }

  /**
   * 直近の週に記録があり、AI 機能に同意した家族のこどものレポートを Batch で依頼する。
   * 同じ週のレポートは 1 件だけ（(childId, periodEnd) の一意制約）。何度呼んでもよい
   */
  async submit(now = new Date(), deadline = Date.now() + SUBMIT_BUDGET_MS) {
    if (!this.config.ai) return { submitted: 0 };
    const period = reportPeriod(now);

    // 依頼の途中で止まった行（batchId なし）を消して、作り直せるようにする
    await this.prisma.weeklyReport.deleteMany({
      where: {
        periodEnd: period.end,
        status: 'PENDING',
        batchId: null,
        createdAt: { lt: new Date(now.getTime() - STRANDED_MS) },
      },
    });

    const targets = await this.prisma.child.findMany({
      where: {
        family: aiEnabledFamily,
        records: { some: { startedAt: { gte: period.start, lt: period.end } } },
        weeklyReports: { none: { periodEnd: period.end } },
      },
      orderBy: { createdAt: 'asc' },
      take: MAX_REPORTS_PER_RUN,
      select: { id: true },
    });

    // 行を作る前に入力を組み立てる（1 人の失敗で全体を止めない）。
    // Batch の作成（通信 1 回）の時間を残して打ち切り、残りは翌日の Cron で依頼する
    const items: { childId: string; input: WeeklyReportInput }[] = [];
    for (const { id: childId } of targets) {
      if (Date.now() > deadline - CALL_MS) break;
      try {
        items.push({
          childId,
          input: await buildWeeklyReportInput(this.prisma, childId, period),
        });
      } catch (e) {
        this.logger.warn(`Skipped a weekly report input: ${(e as Error).name}`);
      }
    }

    const created: { id: string; input: WeeklyReportInput }[] = [];
    for (const { childId, input } of items) {
      try {
        const report = await this.prisma.weeklyReport.create({
          data: {
            childId,
            periodStart: period.start,
            periodEnd: period.end,
            model: this.model.modelName,
          },
          select: { id: true },
        });
        created.push({ id: report.id, input });
      } catch (e) {
        // 同時に実行された別の Cron が先に作った・その間にこどもが削除された
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          (e.code === 'P2002' || e.code === 'P2003')
        ) {
          continue;
        }
        throw e;
      }
    }
    if (created.length === 0) return { submitted: 0 };

    const ids = created.map((c) => c.id);
    try {
      const batchId = await this.model.submitWeeklyReports(
        created.map((c) => ({ customId: c.id, input: c.input })),
      );
      await this.prisma.weeklyReport.updateMany({
        where: { id: { in: ids } },
        data: { batchId },
      });
      this.logger.log(`Submitted ${ids.length} weekly reports`);
      return { submitted: ids.length };
    } catch (e) {
      // 依頼できなかった分は消す。翌日の Cron（同じ週のうち）で作り直す
      await this.prisma.weeklyReport.deleteMany({ where: { id: { in: ids } } });
      throw e;
    }
  }

  /**
   * 未回収の Batch の結果を取り込む。childId を渡すと、そのこどもの分だけを確定する
   * （画面表示から呼ぶときに、他の家族の分の処理を利用者のリクエストで行わないため）
   */
  async collect(options: {
    batchIds?: string[];
    childId?: string;
    deadline?: number;
    fetch?: FetchOptions;
  }) {
    if (!this.config.ai) return { ready: 0, failed: 0 };
    const deadline = options.deadline ?? Date.now() + COLLECT_BUDGET_MS;
    // 1 つの Batch の回収は「状態の確認」と「結果の取得」の通信 2 回
    const perBatchMs = 2 * (options.fetch?.timeoutMs ?? CALL_MS);
    const batchIds =
      options.batchIds ??
      (
        await this.prisma.weeklyReport.findMany({
          where: { status: 'PENDING', batchId: { not: null } },
          distinct: ['batchId'],
          select: { batchId: true },
        })
      ).map((r) => r.batchId!);

    let ready = 0;
    let failed = 0;
    for (const batchId of batchIds) {
      if (Date.now() > deadline - perBatchMs) break;
      try {
        const reports = await this.prisma.weeklyReport.findMany({
          where: {
            batchId,
            status: 'PENDING',
            ...(options.childId && { childId: options.childId }),
          },
          select: {
            id: true,
            periodEnd: true,
            child: {
              select: {
                birthDate: true,
                avoidFoods: true,
                family: {
                  select: { aiConsentAt: true, aiConsentVersion: true },
                },
              },
            },
          },
        });
        if (reports.length === 0) continue;
        // こどもを指定した回収（画面表示）では他の家族の分を確定しないので、同じ Batch の再確認を間引かない
        if (!options.childId) this.lastCheckedAt.set(batchId, Date.now());
        const outcome = await this.model.fetchWeeklyReports(batchId, {
          ...options.fetch,
          ...(options.childId && {
            onlyIds: new Set(reports.map((r) => r.id)),
          }),
        });
        if (!outcome.ended) continue;
        for (const report of reports) {
          const { family } = report.child;
          // 依頼の後に同意が取り消された家族の分は、結果を保存せず・知らせない
          const consented =
            family.aiConsentAt != null &&
            family.aiConsentVersion === AI_CONSENT_VERSION;
          const raw = consented
            ? (outcome.results.get(report.id) ?? null)
            : null;
          const content = raw && this.makeSafe(raw, report);
          if (!(await this.complete(report.id, content))) continue;
          if (content) ready++;
          else failed++;
        }
      } catch (e) {
        // 1 つの Batch の失敗で残りの回収を止めない（次回また試す）
        this.logger.warn(`Failed to collect a batch: ${(e as Error).name}`);
      }
    }
    this.pruneLastChecked();

    // 結果を取りに行った後でも PENDING のまま時間が経ちすぎたものは失敗扱い
    if (!options.childId) {
      await this.prisma.weeklyReport.updateMany({
        where: {
          status: 'PENDING',
          createdAt: { lt: new Date(Date.now() - PENDING_TIMEOUT_MS) },
        },
        data: { status: 'FAILED' },
      });
    }
    return { ready, failed };
  }

  async list(userId: string, childId: string) {
    await this.children.assertAccess(userId, childId);
    await this.collectPendingFor(childId);
    const reports = await this.prisma.weeklyReport.findMany({
      where: { childId },
      orderBy: { periodEnd: 'desc' },
      take: 52,
      select: listSelect,
    });
    // 一覧には見出しだけを返す
    return reports.map(({ content, ...r }) => ({
      ...r,
      headline: (content as WeeklyReportContent | null)?.headline ?? null,
    }));
  }

  async get(userId: string, childId: string, reportId: string) {
    await this.children.assertAccess(userId, childId);
    const report = await this.prisma.weeklyReport.findFirst({
      where: { id: reportId, childId },
      select: listSelect,
    });
    if (!report) {
      throw new NotFoundException({
        code: 'REPORT_NOT_FOUND',
        message: 'Report not found',
      });
    }
    return report;
  }

  /** 画面を開いたとき、そのこどもの未回収のレポートがあれば回収する（メールは Cron で送る） */
  private async collectPendingFor(childId: string) {
    const pending = await this.prisma.weeklyReport.findMany({
      where: { childId, status: 'PENDING', batchId: { not: null } },
      distinct: ['batchId'],
      select: { batchId: true },
    });
    const now = Date.now();
    const due = pending
      .map((p) => p.batchId!)
      .filter(
        (id) =>
          now - (this.lastCheckedAt.get(id) ?? 0) >= LAZY_COLLECT_INTERVAL_MS,
      );
    if (due.length === 0) return;
    try {
      // アプリの待ち時間（20 秒）内に終えるよう、短い制限時間・再試行なしで 1 つの Batch だけ見る
      await this.collect({
        batchIds: due.slice(0, 1),
        childId,
        deadline: now + 2 * LAZY_CALL_MS,
        fetch: { timeoutMs: LAZY_CALL_MS, maxRetries: 0 },
      });
    } catch (e) {
      // 回収に失敗しても一覧の表示は続ける（次回または Cron で回収される）
      this.logger.warn(`Lazy collect failed: ${(e as Error).name}`);
    }
  }

  /** 安全でない項目を取り除く。前向きな項目が残らなければ null（失敗扱い） */
  private makeSafe(
    content: WeeklyReportContent,
    report: {
      periodEnd: Date;
      child: { birthDate: Date; avoidFoods: string | null };
    },
  ): WeeklyReportContent | null {
    return filterUnsafeReport(content, {
      ageMonths: ageInMonths(report.child.birthDate, report.periodEnd),
      avoidFoods: report.child.avoidFoods,
    });
  }

  /** PENDING のものだけを更新する（Cron と画面表示の回収が重なっても 1 回だけ反映） */
  private async complete(id: string, content: WeeklyReportContent | null) {
    const { count } = await this.prisma.weeklyReport.updateMany({
      where: { id, status: 'PENDING' },
      data: content
        ? { status: 'READY', content, readyAt: new Date() }
        : { status: 'FAILED' },
    });
    return count === 1;
  }

  /**
   * 完成したレポートを家族に知らせる。送る前に notifiedAt を付けて「自分が送る」ことを確定するので、
   * Cron が重なっても二重に送らない。まだ誰にも送っていないレポートは次回の Cron で送る
   * （送信の途中で処理が止まった場合、残りの家族には届かない。レポートはアプリで見られる）。
   * 回収は 1 日 1 回なので、金曜の依頼分のメールは多くが翌日の 20 時ごろになる（アプリでは先に見られる）
   */
  private async notifyReady(deadline: number) {
    const mail = this.config.mail;
    if (!mail) return 0;
    const reports = await this.prisma.weeklyReport.findMany({
      where: {
        status: 'READY',
        notifiedAt: null,
        readyAt: { gt: new Date(Date.now() - NOTIFY_WITHIN_MS) },
        // 同意を取り消した家族には送らない
        child: { family: aiEnabledFamily },
      },
      take: 100,
      select: {
        id: true,
        child: {
          select: {
            name: true,
            family: {
              select: {
                members: { select: { user: { select: { email: true } } } },
              },
            },
          },
        },
      },
    });
    let sent = 0;
    for (const report of reports) {
      if (Date.now() > deadline) break;
      const { count } = await this.prisma.weeklyReport.updateMany({
        where: { id: report.id, notifiedAt: null },
        data: { notifiedAt: new Date() },
      });
      if (count === 0) continue;
      for (const { user } of report.child.family.members) {
        try {
          await this.mailer.send(
            buildWeeklyReportMail({
              to: user.email,
              childName: report.child.name,
              appUrl: mail.appUrl,
            }),
          );
          sent++;
        } catch {
          // 通知の失敗でレポート自体は失敗にしない（アプリで見られる）
          this.logger.warn('Failed to send weekly report mail');
        }
      }
    }
    return sent;
  }

  private pruneLastChecked() {
    const cutoff = Date.now() - HOUR_MS;
    for (const [id, at] of this.lastCheckedAt) {
      if (at < cutoff) this.lastCheckedAt.delete(id);
    }
  }
}
