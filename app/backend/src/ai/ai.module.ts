import { Module } from '@nestjs/common';
import { ChildrenModule } from '../children/children.module.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { AI_MODEL, createAiModel } from './ai-model.js';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';
import { CronController } from './cron.controller.js';
import { WeeklyReportJob } from './weekly-report.job.js';

@Module({
  imports: [ChildrenModule],
  controllers: [AiController, CronController],
  providers: [
    {
      provide: AI_MODEL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createAiModel(config),
    },
    AiService,
    WeeklyReportJob,
  ],
})
export class AiModule {}
