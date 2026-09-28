import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  Public,
  type AuthUser,
} from '../common/auth.decorators.js';
import { RateLimit } from '../common/rate-limit.js';
import { CronGuard } from './cron.guard.js';
import { MealSuggestionsService } from './meal-suggestions.service.js';
import { WeeklyReportsService } from './weekly-reports.service.js';

// 提案は Claude を呼ぶので、日ごとの上限に加えて短時間の連打も抑える
const SUGGEST_LIMIT = { limit: 5, ttlMs: 60_000 };

@Controller()
export class InsightsController {
  constructor(
    private readonly suggestions: MealSuggestionsService,
    private readonly reports: WeeklyReportsService,
  ) {}

  @Get('children/:childId/meal-suggestions/latest')
  latestSuggestion(
    @CurrentUser() user: AuthUser,
    @Param('childId', ParseUUIDPipe) childId: string,
  ) {
    return this.suggestions.latest(user.id, childId);
  }

  @RateLimit(SUGGEST_LIMIT)
  @Post('children/:childId/meal-suggestions')
  suggest(
    @CurrentUser() user: AuthUser,
    @Param('childId', ParseUUIDPipe) childId: string,
  ) {
    return this.suggestions.create(user.id, childId);
  }

  @Get('children/:childId/weekly-reports')
  listReports(
    @CurrentUser() user: AuthUser,
    @Param('childId', ParseUUIDPipe) childId: string,
  ) {
    return this.reports.list(user.id, childId);
  }

  @Get('children/:childId/weekly-reports/:reportId')
  getReport(
    @CurrentUser() user: AuthUser,
    @Param('childId', ParseUUIDPipe) childId: string,
    @Param('reportId', ParseUUIDPipe) reportId: string,
  ) {
    return this.reports.get(user.id, childId, reportId);
  }
}

/** Vercel Cron 専用（GET で呼ばれる）。利用者のトークンではなく CRON_SECRET で認証する */
@Public()
@UseGuards(CronGuard)
@Controller('cron/weekly-reports')
export class CronController {
  constructor(private readonly reports: WeeklyReportsService) {}

  /** 金曜 17:00 JST: その週のレポートを依頼 */
  @Get('submit')
  @Header('Cache-Control', 'no-store')
  submit() {
    return this.reports.submit();
  }

  /** 毎日 20:00 JST: 依頼漏れの再依頼・結果の回収・完成メール・古い提案の削除 */
  @Get('collect')
  @Header('Cache-Control', 'no-store')
  collect() {
    return this.reports.runDaily();
  }
}
