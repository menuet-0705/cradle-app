import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../common/auth.decorators.js';
import { RateLimit } from '../common/rate-limit.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  chartCommentQuerySchema,
  chartParamSchema,
  listWeeklyReportsSchema,
  type ChartCommentQuery,
  type ChartParam,
  updateNotificationSettingsSchema,
  type ListWeeklyReportsDto,
  type UpdateNotificationSettingsDto,
} from './ai.dto.js';
import { AiService } from './ai.service.js';
import { ChartCommentsService } from './chart-comments.service.js';

@Controller()
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly chartComments: ChartCommentsService,
  ) {}

  @Get('children/:childId/ai/meal-suggestions/latest')
  latestMealSuggestion(
    @CurrentUser() user: AuthUser,
    @Param('childId', ParseUUIDPipe) childId: string,
  ) {
    return this.ai.latestMealSuggestion(user.id, childId);
  }

  // 1 日の回数上限は DB で数える。こちらは連打・総当たり向けの簡易な制限
  @RateLimit({ limit: 10, ttlMs: 60_000 })
  @Post('children/:childId/ai/meal-suggestions')
  createMealSuggestion(
    @CurrentUser() user: AuthUser,
    @Param('childId', ParseUUIDPipe) childId: string,
  ) {
    return this.ai.createMealSuggestion(user.id, childId);
  }

  @Get('children/:childId/ai/chart-comments/:chart')
  chartComment(
    @CurrentUser() user: AuthUser,
    @Param('childId', ParseUUIDPipe) childId: string,
    @Param('chart', new ZodValidationPipe(chartParamSchema)) chart: ChartParam,
    @Query(new ZodValidationPipe(chartCommentQuerySchema)) q: ChartCommentQuery,
  ) {
    return this.chartComments.state(user.id, childId, chart, q.tz);
  }

  // 1 日の回数上限は DB で数える。こちらは連打・総当たり向けの簡易な制限
  @RateLimit({ limit: 10, ttlMs: 60_000 })
  @Post('children/:childId/ai/chart-comments/:chart')
  createChartComment(
    @CurrentUser() user: AuthUser,
    @Param('childId', ParseUUIDPipe) childId: string,
    @Param('chart', new ZodValidationPipe(chartParamSchema)) chart: ChartParam,
    @Body(new ZodValidationPipe(chartCommentQuerySchema))
    body: ChartCommentQuery,
  ) {
    return this.chartComments.create(user.id, childId, chart, body.tz);
  }

  @Get('children/:childId/ai/weekly-reports')
  listWeeklyReports(
    @CurrentUser() user: AuthUser,
    @Param('childId', ParseUUIDPipe) childId: string,
    @Query(new ZodValidationPipe(listWeeklyReportsSchema))
    q: ListWeeklyReportsDto,
  ) {
    return this.ai.listWeeklyReports(user.id, childId, q);
  }

  @Get('me/notification-settings')
  getNotificationSettings(@CurrentUser() user: AuthUser) {
    return this.ai.getNotificationSettings(user.id);
  }

  @Patch('me/notification-settings')
  updateNotificationSettings(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(updateNotificationSettingsSchema))
    dto: UpdateNotificationSettingsDto,
  ) {
    return this.ai.updateNotificationSettings(user.id, dto);
  }
}
