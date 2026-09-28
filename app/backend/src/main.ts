import { createApp } from './app.factory.js';
import { APP_CONFIG, type AppConfig } from './config/env.js';

// ローカル起動用。.env があれば読み込む（既に設定済みの環境変数は上書きしない）
try {
  process.loadEnvFile();
} catch {
  // .env がない環境（CI など）は環境変数をそのまま使う
}

const app = await createApp();
app.enableShutdownHooks();
await app.listen(app.get<AppConfig>(APP_CONFIG).PORT);
