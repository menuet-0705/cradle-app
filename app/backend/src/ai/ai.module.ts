import { Module } from '@nestjs/common';
import { ChildrenModule } from '../children/children.module.js';
import { RecordsModule } from '../records/records.module.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { AI_MODEL, createAiModel } from './ai-model.js';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';
import { ChartCommentsService } from './chart-comments.service.js';
import { CronController } from './cron.controller.js';
import { WeeklyReportJob } from './weekly-report.job.js';

@Module({
  imports: [ChildrenModule, RecordsModule],
  controllers: [AiController, CronController],
  providers: [
    {
      provide: AI_MODEL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createAiModel(config),
    },
    AiService,
    ChartCommentsService,
    WeeklyReportJob,
  ],
})
export class AiModule {}
