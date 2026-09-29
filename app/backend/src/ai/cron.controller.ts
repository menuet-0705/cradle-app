import {
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Public } from '../common/auth.decorators.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { WeeklyReportJob } from './weekly-report.job.js';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Vercel Cron から呼ばれる定期実行。Vercel は `Authorization: Bearer <CRON_SECRET>` を付ける */
@Controller('internal/cron')
export class CronController {
  constructor(
    private readonly weeklyReports: WeeklyReportJob,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // 利用者の JWT ではなく CRON_SECRET で認証する
  @Public()
  @Get('weekly-reports')
  runWeeklyReports(@Headers('authorization') authorization?: string) {
    const secret = this.config.CRON_SECRET;
    // 未設定なら存在しないものとして扱う（誰でも実行できる状態にしない）
    if (!secret) throw new NotFoundException();
    // 長さや内容で所要時間が変わらないよう、ハッシュ同士を定数時間で比べる
    if (
      !timingSafeEqual(digest(authorization ?? ''), digest(`Bearer ${secret}`))
    ) {
      throw new UnauthorizedException();
    }
    return this.weeklyReports.run();
  }
}
