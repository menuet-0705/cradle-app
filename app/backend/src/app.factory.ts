import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig } from './config/env.js';

/** ローカル起動 / Vercel / e2e テストで共通のアプリ設定 */
export function configureApp(app: INestApplication): INestApplication {
  const config = app.get<AppConfig>(APP_CONFIG);
  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  // credentials は許可しない（Web のリフレッシュ Cookie を別オリジンから使わせないための前提。refresh-cookie.ts 参照）
  app.enableCors({
    origin: config.CORS_ORIGINS,
    credentials: false,
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  if (config.isVercel) {
    // Vercel のプロキシ越しでも利用者の IP でレート制限する（Preview でも有効にするため VERCEL で判定）
    (app as NestExpressApplication).set('trust proxy', 1);
  }
  return app;
}

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  return configureApp(app);
}
