import { Module } from '@nestjs/common';
import { ChildrenModule } from '../children/children.module.js';
import { CronController, InsightsController } from './insights.controller.js';
import { AnthropicInsightsModel, INSIGHTS_MODEL } from './insights-model.js';
import { MealSuggestionsService } from './meal-suggestions.service.js';
import { WeeklyReportsService } from './weekly-reports.service.js';

@Module({
  imports: [ChildrenModule],
  controllers: [InsightsController, CronController],
  providers: [
    MealSuggestionsService,
    WeeklyReportsService,
    { provide: INSIGHTS_MODEL, useClass: AnthropicInsightsModel },
  ],
})
export class InsightsModule {}
