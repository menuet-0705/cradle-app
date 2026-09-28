import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ChildrenService } from '../children/children.service.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { AI_CONSENT_VERSION } from '../families/ai-consent.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { buildMealSuggestionInput, jstStartOfDay } from './aggregate.js';
import {
  INSIGHTS_MODEL,
  aiUnavailable,
  type InsightsModel,
} from './insights-model.js';
import { filterUnsafeSuggestions } from './safety.js';

// 費用の上限（日本時間の 1 日あたり）。こどもを増やしても上限が増えないよう、人・家族単位でも数える
export const MAX_SUGGESTIONS_PER_CHILD_PER_DAY = 3;
const MAX_SUGGESTIONS_PER_USER_PER_DAY = 10;
const MAX_SUGGESTIONS_PER_FAMILY_PER_DAY = 10;
const TX_OPTIONS = { maxWait: 5000, timeout: 5000 };

const select = {
  id: true,
  content: true,
  model: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
} as const;

const limitReached = () =>
  new HttpException(
    { code: 'SUGGESTION_LIMIT', message: 'Daily suggestion limit reached' },
    HttpStatus.TOO_MANY_REQUESTS,
  );

@Injectable()
export class MealSuggestionsService {
  private readonly logger = new Logger(MealSuggestionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly children: ChildrenService,
    @Inject(INSIGHTS_MODEL) private readonly model: InsightsModel,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async latest(userId: string, childId: string) {
    await this.children.assertAccess(userId, childId);
    const { familyId } = await this.prisma.child.findUniqueOrThrow({
      where: { id: childId },
      select: { familyId: true },
    });
    const [suggestion, remainingToday] = await Promise.all([
      this.prisma.mealSuggestion.findFirst({
        where: { childId, status: 'READY' },
        orderBy: { createdAt: 'desc' },
        select,
      }),
      // こどもの上限だけでなく、人・家族の上限も反映した残り回数
      this.remaining(
        this.prisma,
        { userId, childId, familyId },
        jstStartOfDay(new Date()),
      ),
    ]);
    return {
      suggestion,
      limitPerDay: MAX_SUGGESTIONS_PER_CHILD_PER_DAY,
      remainingToday,
    };
  }

  async create(userId: string, childId: string) {
    await this.children.assertAccess(userId, childId);
    const child = await this.prisma.child.findUniqueOrThrow({
      where: { id: childId },
      select: {
        familyId: true,
        avoidFoods: true,
        family: { select: { aiConsentAt: true, aiConsentVersion: true } },
      },
    });
    if (
      !child.family.aiConsentAt ||
      child.family.aiConsentVersion !== AI_CONSENT_VERSION
    ) {
      throw new ForbiddenException({
        code: 'AI_CONSENT_REQUIRED',
        message: 'AI features are not enabled for this family',
      });
    }

    const now = new Date();
    const reservation = await this.reserve(
      userId,
      childId,
      child.familyId,
      now,
    );

    try {
      const input = await buildMealSuggestionInput(this.prisma, childId, now);
      const generated = await this.model.suggestMeals(input);
      // 避けたい食材・月齢に合わない食品を含む献立は、生成後にも取り除く
      const content = filterUnsafeSuggestions(generated, {
        ageMonths: input.child.ageMonths,
        avoidFoods: child.avoidFoods,
      });
      if (!content) {
        this.logger.warn('All meal suggestions were filtered as unsafe');
        throw aiUnavailable();
      }
      const suggestion = await this.prisma.mealSuggestion.update({
        where: { id: reservation.id },
        data: { status: 'READY', content },
        select,
      });
      return {
        suggestion,
        limitPerDay: MAX_SUGGESTIONS_PER_CHILD_PER_DAY,
        remainingToday: reservation.remainingToday,
      };
    } catch (e) {
      // 失敗しても課金されうるので、回数には数えたまま FAILED にする
      await this.prisma.mealSuggestion
        .update({ where: { id: reservation.id }, data: { status: 'FAILED' } })
        .catch(() => undefined);
      throw e;
    }
  }

  /** こども・人・家族それぞれの今日の残り回数のうち、いちばん少ないもの */
  private async remaining(
    db: Pick<PrismaService, 'mealSuggestion'>,
    ids: { userId: string; childId: string; familyId: string },
    since: Date,
  ) {
    const count = (where: Prisma.MealSuggestionWhereInput) =>
      db.mealSuggestion.count({
        where: { ...where, createdAt: { gte: since } },
      });
    const byChild = await count({ childId: ids.childId });
    const byUser = await count({ createdById: ids.userId });
    const byFamily = await count({ child: { familyId: ids.familyId } });
    return Math.max(
      0,
      Math.min(
        MAX_SUGGESTIONS_PER_CHILD_PER_DAY - byChild,
        MAX_SUGGESTIONS_PER_USER_PER_DAY - byUser,
        MAX_SUGGESTIONS_PER_FAMILY_PER_DAY - byFamily,
      ),
    );
  }

  /**
   * Claude を呼ぶ前に回数枠を確保する。ロックの中で数えてから PENDING の行を作るので、
   * 同時に押されても上限を超えない（失敗・処理中の分も数える）。
   * アカウントを大量に作っても費用が増え続けないよう、サービス全体の 1 日の上限も確認する。
   * ロックは全体で 1 つ（短いトランザクションなので直列化しても問題ない。人・家族をまたぐ競合も防げる）
   */
  private reserve(
    userId: string,
    childId: string,
    familyId: string,
    now: Date,
  ) {
    const since = jstStartOfDay(now);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('meal_suggestion:reserve'))`;
      const remaining = await this.remaining(
        tx,
        { userId, childId, familyId },
        since,
      );
      if (remaining <= 0) throw limitReached();
      const total = await tx.mealSuggestion.count({
        where: { createdAt: { gte: since } },
      });
      if (total >= this.config.AI_SUGGESTIONS_DAILY_MAX) {
        this.logger.warn('Daily suggestion limit for the service reached');
        throw new HttpException(
          { code: 'AI_BUSY', message: 'AI is busy' },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      const row = await tx.mealSuggestion.create({
        data: { childId, createdById: userId, model: this.model.modelName },
        select: { id: true },
      });
      return { id: row.id, remainingToday: remaining - 1 };
    }, TX_OPTIONS);
  }
}
