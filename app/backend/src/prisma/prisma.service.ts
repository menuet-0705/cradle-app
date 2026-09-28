import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({
      adapter: new PrismaPg({
        connectionString: config.DATABASE_URL,
        // サーバーレスでは同時実行インスタンスごとに接続が張られるため、1インスタンスあたりは少なくする
        max: config.DB_POOL_MAX,
      }),
    });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
