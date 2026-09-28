import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import { ChildrenModule } from './children/children.module.js';
import { RateLimitGuard, RateLimitStore } from './common/rate-limit.js';
import { ConfigModule } from './config/config.module.js';
import { HealthController } from './health/health.controller.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RecordsModule } from './records/records.module.js';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AuthModule,
    ChildrenModule,
    RecordsModule,
  ],
  controllers: [HealthController],
  providers: [RateLimitStore, { provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class AppModule {}
