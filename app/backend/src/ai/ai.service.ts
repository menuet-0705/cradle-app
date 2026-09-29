import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ChildrenService } from '../children/children.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AI_MODEL, isAiConfigured, type AiModel } from './ai-model.js';
import {
  aiBusy,
  dailyLimitReached,
  overGlobalLimit,
  PENDING_STALE_MS,
  startOfJstDay,
  userAttemptsLeft,
} from './ai-usage.js';
import type {
  ListWeeklyReportsDto,
  UpdateNotificationSettingsDto,
} from './ai.dto.js';
import {
  buildMealSuggestionGraph,
  runMealSuggestion,
  type MealSuggestionContent,
  type MealSuggestionGraph,
} from './meal-suggestion.graph.js';
import { ageInMonths, formatJst, redactNames } from './prompt.js';

/** 食事の提案: こども 1 人あたり 1 日（JST）に成功できる回数 */
export const MEAL_SUGGESTION_DAILY_LIMIT = 3;
// 失敗も含めた試行の上限（LLM の料金は失敗しても発生する。失敗させ続けて無制限に呼ばせない）
const MEAL_SUGGESTION_DAILY_ATTEMPTS = 6;
const MEAL_LOOKBACK_DAYS = 30;
const MAX_MEALS = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

const suggestionSelect = {
  id: true,
  content: true,
  createdAt: true,
} as const satisfies Prisma.MealSuggestionSelect;

const mealLimitReached = () =>
  dailyLimitReached('Daily meal suggestion limit reached');

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly mealGraph: MealSuggestionGraph;

  constructor(
    private readonly prisma: PrismaService,
    private readonly children: ChildrenService,
    @Inject(AI_MODEL) private readonly model: AiModel,
  ) {
    this.mealGraph = buildMealSuggestionGraph(model);
  }

  /** 直近の提案と、今日あと何回提案できるか */
  async latestMealSuggestion(userId: string, childId: string) {
    await this.children.assertAccess(userId, childId);
    const [suggestion, usage] = await Promise.all([
      this.prisma.mealSuggestion.findFirst({
        // content が null の行は生成中か、生成に失敗したもの
        where: { childId, content: { not: Prisma.DbNull } },
        select: suggestionSelect,
        orderBy: { createdAt: 'desc' },
      }),
      this.usageToday(childId, userId, new Date()),
    ]);
    return {
      suggestion,
      remainingToday: usage.remaining,
      enabled: isAiConfigured(this.model),
    };
  }

  async createMealSuggestion(userId: string, childId: string) {
    await this.children.assertAccess(userId, childId);
    if (!isAiConfigured(this.model)) {
      throw new ServiceUnavailableException('AI is not configured');
    }
    const now = new Date();
    // 上限に達していれば、記録を読む前に断る
    if ((await this.usageToday(childId, userId, now)).remaining === 0) {
      throw mealLimitReached();
    }
    const [child, meals] = await Promise.all([
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
        where: {
          childId,
          type: 'MEAL',
          startedAt: { gte: new Date(+now - MEAL_LOOKBACK_DAYS * DAY_MS) },
        },
        select: { startedAt: true, note: true },
        orderBy: { startedAt: 'desc' },
        take: MAX_MEALS,
      }),
    ]);
    if (meals.length === 0) {
      throw new UnprocessableEntityException({
        message: 'No meal records in the last 30 days',
        code: 'NO_MEAL_RECORDS',
      });
    }

    // 先に行を作ってから今日の件数を数える（同時に依頼されても上限を超えない。
    // 残り 1 回のときに同時に来ると両方断ることがあるが、超えるよりは安全側に倒す）
    const [reserved, usageRow] = await this.prisma.$transaction([
      this.prisma.mealSuggestion.create({
        data: { childId, createdById: userId, model: this.model.name },
        select: { id: true },
      }),
      this.prisma.aiUsage.create({
        data: { kind: 'MEAL_SUGGESTION', userId },
        select: { id: true },
      }),
    ]);
    const [usage, overGlobal] = await Promise.all([
      this.usageToday(childId, userId, now),
      overGlobalLimit(this.prisma, 'MEAL_SUGGESTION', now),
    ]);
    if (usage.exceeded || overGlobal) {
      // LLM は呼んでいないので試行には数えない
      await this.discard(reserved.id, usageRow.id);
      if (usage.exceeded) throw mealLimitReached();
      this.logger.warn('Global daily meal suggestion limit reached');
      throw aiBusy();
    }

    let content: MealSuggestionContent;
    try {
      content = await runMealSuggestion(this.mealGraph, {
        ageMonths: ageInMonths(child.birthDate, now),
        sex: child.sex,
        meals: meals.map((m) => ({
          at: formatJst(m.startedAt),
          // メモに書かれたこどもの名前は外部の LLM に送らない
          note: redactNames(
            m.note ?? '',
            child.family.children.map((c) => c.name),
          ),
        })),
      });
    } catch (e) {
      // 失敗も試行として残す（成功回数には数えない。ai_usages の行も残す）
      await this.prisma.mealSuggestion
        .update({ where: { id: reserved.id }, data: { failedAt: new Date() } })
        .catch(() => this.logger.error('Failed to mark a meal suggestion'));
      throw e;
    }
    const suggestion = await this.prisma.mealSuggestion.update({
      where: { id: reserved.id },
      data: { content },
      select: suggestionSelect,
    });
    return {
      suggestion,
      remainingToday: usage.remaining,
      enabled: true,
    };
  }

  async listWeeklyReports(
    userId: string,
    childId: string,
    q: ListWeeklyReportsDto,
  ) {
    await this.children.assertAccess(userId, childId);
    return this.prisma.weeklyReport.findMany({
      where: { childId },
      select: {
        id: true,
        periodStart: true,
        periodEnd: true,
        summary: true,
        content: true,
        createdAt: true,
      },
      orderBy: { periodEnd: 'desc' },
      take: q.limit,
    });
  }

  getNotificationSettings(userId: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { weeklyReportEmail: true },
    });
  }

  updateNotificationSettings(
    userId: string,
    dto: UpdateNotificationSettingsDto,
  ) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { weeklyReportEmail: dto.weeklyReportEmail },
      select: { weeklyReportEmail: true },
    });
  }

  /**
   * 今日（JST）の使用状況。
   * こども単位: 成功と生成中（強制終了で残った古い行は除く）が 3 回、失敗も含む試行が 6 回まで。
   * 利用者単位: 試行が 20 回（作成 1 日以内のアカウントは 6 回）まで（こどもの削除で消えない ai_usages で数える）。
   * 予約した行を含めて数えたあとなら、exceeded が上限を超えたかを表す
   */
  private async usageToday(childId: string, userId: string, now: Date) {
    const today = { gte: startOfJstDay(now) };
    const [used, attempts, userLeft] = await Promise.all([
      this.prisma.mealSuggestion.count({
        where: {
          childId,
          createdAt: today,
          OR: [
            { content: { not: Prisma.DbNull } },
            {
              failedAt: null,
              createdAt: { gt: new Date(+now - PENDING_STALE_MS) },
            },
          ],
        },
      }),
      this.prisma.mealSuggestion.count({
        where: { childId, createdAt: today },
      }),
      userAttemptsLeft(this.prisma, 'MEAL_SUGGESTION', userId, now),
    ]);
    const left = [
      MEAL_SUGGESTION_DAILY_LIMIT - used,
      MEAL_SUGGESTION_DAILY_ATTEMPTS - attempts,
      userLeft,
    ];
    return {
      remaining: Math.max(0, Math.min(...left)),
      exceeded: left.some((n) => n < 0),
    };
  }

  private async discard(suggestionId: string, usageId: string) {
    await this.prisma
      .$transaction([
        this.prisma.mealSuggestion.delete({ where: { id: suggestionId } }),
        this.prisma.aiUsage.delete({ where: { id: usageId } }),
      ])
      .catch(() => this.logger.error('Failed to discard a meal suggestion'));
  }
}
