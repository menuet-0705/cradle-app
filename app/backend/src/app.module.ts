import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AiModule } from './ai/ai.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ChildrenModule } from './children/children.module.js';
import { RateLimitGuard, RateLimitStore } from './common/rate-limit.js';
import { ConfigModule } from './config/config.module.js';
import { FamiliesModule } from './families/families.module.js';
import { HealthController } from './health/health.controller.js';
import { MailModule } from './mail/mail.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RecordsModule } from './records/records.module.js';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    MailModule,
    AuthModule,
    ChildrenModule,
    RecordsModule,
    FamiliesModule,
    AiModule,
  ],
  controllers: [HealthController],
  providers: [RateLimitStore, { provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class AppModule {}
