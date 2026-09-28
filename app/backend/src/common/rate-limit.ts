import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { isIPv6 } from 'node:net';

/**
 * IP × エンドポイント単位の簡易レート制限（固定ウィンドウ）。
 *
 * @nestjs/throttler は CommonJS のまま ESM 専用の NestJS 12 を require しており、
 * Vercel の実行環境（require(esm) 非対応のローダー）で起動できないため自前で持つ。
 * カウンタはメモリ上なので、サーバーレスではインスタンス単位の制限になる（簡易的な防御）。
 */
export interface RateLimitOptions {
  limit: number;
  ttlMs: number;
}

const RATE_LIMIT = 'rateLimit';
const DEFAULT_LIMIT: RateLimitOptions = { limit: 120, ttlMs: 60_000 };

/** エンドポイントごとの上限（未指定は 1 分 120 回） */
export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT, options);

interface Window {
  count: number;
  resetAt: number;
}

// メモリを使い切らないための上限。超えたら古い窓から捨てる（Map は挿入順）
const MAX_KEYS = 50_000;
const SWEEP_INTERVAL_MS = 60_000;

@Injectable()
export class RateLimitStore {
  private readonly windows = new Map<string, Window>();
  private lastSweepAt = 0;

  hit(key: string, ttlMs: number, now = Date.now()): Window {
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      this.windows.delete(key); // 挿入順を「最近使った順」に保つ
      this.evict(now);
      window = { count: 0, resetAt: now + ttlMs };
      this.windows.set(key, window);
    }
    window.count++;
    return window;
  }

  clear() {
    this.windows.clear();
  }

  get size() {
    return this.windows.size;
  }

  private evict(now: number) {
    // 期限切れの掃除は一定間隔でのみ行う（リクエストごとの全走査を避ける）
    if (now - this.lastSweepAt >= SWEEP_INTERVAL_MS) {
      this.lastSweepAt = now;
      for (const [key, w] of this.windows) {
        if (w.resetAt <= now) this.windows.delete(key);
      }
    }
    // それでも多すぎる場合は古いものから捨てる
    for (const key of this.windows.keys()) {
      if (this.windows.size < MAX_KEYS) break;
      this.windows.delete(key);
    }
  }
}

/**
 * 制限の単位とする送信元。IPv6 は利用者が /64 内のアドレスを自由に変えられるため /64 単位にまとめる
 */
export function clientKey(req: Request): string {
  const ip = (req.ip ?? req.socket?.remoteAddress ?? 'unknown').toLowerCase();
  const [head] = ip.split('%'); // ゾーン ID を除く
  // IPv4 と IPv4 埋め込み表記（::ffff:1.2.3.4 など）、想定外の形式はそのまま使う
  if (!isIPv6(head) || head.includes('.')) return ip;
  const [left, right = ''] = head.split('::');
  const leftParts = left ? left.split(':') : [];
  const rightParts = right ? right.split(':') : [];
  const full = [
    ...leftParts,
    ...Array<string>(8 - leftParts.length - rightParts.length).fill('0'),
    ...rightParts,
  ];
  return `${full
    .slice(0, 4)
    .map((g) => parseInt(g || '0', 16).toString(16))
    .join(':')}::/64`;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly store: RateLimitStore,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const { limit, ttlMs } =
      this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? DEFAULT_LIMIT;
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request>();
    const key = `${clientKey(req)}|${ctx.getClass().name}.${ctx.getHandler().name}`;

    const now = Date.now();
    const window = this.store.hit(key, ttlMs, now);
    if (window.count <= limit) return true;

    const retryAfter = Math.ceil((window.resetAt - now) / 1000);
    http.getResponse<Response>().setHeader('Retry-After', String(retryAfter));
    throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
  }
}
