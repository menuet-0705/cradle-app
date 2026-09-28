import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from './app.factory.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

// ウォームスタート時は初期化済みのアプリを使い回す
let handlerPromise: Promise<Handler> | undefined;

async function init(): Promise<Handler> {
  const app = await createApp();
  await app.init();
  return app.getHttpAdapter().getInstance() as Handler;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  handlerPromise ??= init().catch((e: unknown) => {
    handlerPromise = undefined; // 初期化失敗は次のリクエストで再試行
    throw e;
  });
  const app = await handlerPromise;
  app(req, res);
}
