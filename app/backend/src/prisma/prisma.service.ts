import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  /** 生 SQL で使うスキーマ修飾済みの識別子（例: "cradle-app"） */
  readonly schema: Prisma.Sql;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({
      adapter: new PrismaPg(
        {
          connectionString: config.DATABASE_URL,
          // サーバーレスでは同時実行インスタンスごとに接続が張られるため、1インスタンスあたりは少なくする
          max: config.DB_POOL_MAX,
        },
        // `?schema=` はドライバアダプタでは解釈されないので明示的に渡す
        { schema: config.dbSchema },
      ),
    });
    // 名前は env.ts で検証済みだが、念のため識別子として引用符をエスケープする
    this.schema = Prisma.raw(`"${config.dbSchema.replaceAll('"', '""')}"`);
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
