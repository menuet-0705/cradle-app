import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/env.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/**
 * Vercel Cron からの呼び出しだけを通す。
 * Vercel は CRON_SECRET を設定すると `Authorization: Bearer <CRON_SECRET>` を付けて呼ぶ
 */
@Injectable()
export class CronGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const secret = this.config.CRON_SECRET;
    // 未設定なら Cron のエンドポイント自体が存在しないように見せる
    if (!secret) throw new NotFoundException();
    const header = ctx.switchToHttp().getRequest<Request>()
      .headers.authorization;
    // 長さの違いで時間差が出ないよう、ハッシュ同士を比べる
    const ok =
      typeof header === 'string' &&
      timingSafeEqual(sha256(header), sha256(`Bearer ${secret}`));
    if (!ok) throw new UnauthorizedException();
    return true;
  }
}
