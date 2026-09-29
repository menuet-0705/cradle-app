import { Injectable, NotFoundException } from '@nestjs/common';
import { ChildrenService } from '../children/children.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CreateRecordDto,
  ListRecordsDto,
  MilkDailyDto,
} from './records.dto.js';

const recordSelect = {
  id: true,
  childId: true,
  type: true,
  startedAt: true,
  endedAt: true,
  amountMl: true,
  weightG: true,
  note: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
} as const;

// 同じこどもへの同時保存はロックで順番待ちになるので、既定（2 秒）より長く待つ
const TX_OPTIONS = { maxWait: 5000, timeout: 5000 };

@Injectable()
export class RecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly children: ChildrenService,
  ) {}

  async list(userId: string, childId: string, q: ListRecordsDto) {
    await this.children.assertAccess(userId, childId);
    return this.prisma.record.findMany({
      where: {
        childId,
        type: q.type,
        startedAt: { gte: q.from, lt: q.to },
      },
      select: recordSelect,
      // 同じ時刻なら後から作った方を先に（体重の上書き対象と同じ順）
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
      take: 1000,
    });
  }

  async create(userId: string, childId: string, dto: CreateRecordDto) {
    await this.children.assertAccess(userId, childId);
    if (dto.type === 'WEIGHT') {
      return this.saveDailyWeight(userId, childId, dto);
    }
    return this.prisma.record.create({
      data: {
        childId,
        createdById: userId,
        type: dto.type,
        startedAt: dto.startedAt,
        endedAt: dto.type === 'SLEEP' ? dto.endedAt : null,
        amountMl: dto.type === 'MILK' ? dto.amountMl : null,
        note: dto.note ?? null,
      },
      select: recordSelect,
    });
  }

  /**
   * 体重は 1 日 1 件。同じ日（dto.tz で区切る）にすでにあれば、その記録を上書きする。
   * 確認と作成を同時リクエストで追い越されないよう、こどもごとのロックを取って 1 件ずつ行う
   */
  private saveDailyWeight(
    userId: string,
    childId: string,
    dto: Extract<CreateRecordDto, { type: 'WEIGHT' }>,
  ) {
    const startedAt = dto.startedAt.toISOString();
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('records:weight:' || ${childId}))`;
      // 過去に同じ日に複数登録されている場合は、最も新しい 1 件を更新する
      const [existing] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id
          FROM ${this.prisma.schema}.records
         WHERE child_id = ${childId}::uuid
           AND type = 'WEIGHT'
           -- インデックス (child_id, type, started_at) を使うための粗い範囲（夏時間で 1 日が 25 時間の日も含める）
           AND started_at >= ${startedAt}::timestamptz - interval '26 hours'
           AND started_at <  ${startedAt}::timestamptz + interval '26 hours'
           AND (started_at AT TIME ZONE ${dto.tz})::date
             = (${startedAt}::timestamptz AT TIME ZONE ${dto.tz})::date
         ORDER BY started_at DESC, created_at DESC
         LIMIT 1`;
      const data = {
        startedAt: dto.startedAt,
        weightG: dto.weightG,
        note: dto.note ?? null,
      };
      return existing
        ? tx.record.update({
            where: { id: existing.id },
            data,
            select: recordSelect,
          })
        : tx.record.create({
            data: { ...data, childId, createdById: userId, type: 'WEIGHT' },
            select: recordSelect,
          });
    }, TX_OPTIONS);
  }

  async remove(userId: string, recordId: string) {
    // 所属家族のこどもの記録だけを削除対象にする
    const { count } = await this.prisma.record.deleteMany({
      where: {
        id: recordId,
        child: { family: { members: { some: { userId } } } },
      },
    });
    if (count === 0) throw new NotFoundException('Record not found');
  }

  async weightSeries(userId: string, childId: string) {
    await this.children.assertAccess(userId, childId);
    return this.prisma.record.findMany({
      where: { childId, type: 'WEIGHT' },
      select: { startedAt: true, weightG: true },
      orderBy: { startedAt: 'asc' },
      take: 1000,
    });
  }

  async milkDaily(userId: string, childId: string, q: MilkDailyDto) {
    await this.children.assertAccess(userId, childId);
    // 値は全てバインド変数で渡す（$queryRaw のタグ付きテンプレート）
    const rows = await this.prisma.$queryRaw<
      { date: string; totalMl: bigint; count: bigint }[]
    >`
      SELECT to_char((started_at AT TIME ZONE ${q.tz})::date, 'YYYY-MM-DD') AS "date",
             COALESCE(SUM(amount_ml), 0) AS "totalMl",
             COUNT(*) AS "count"
        FROM ${this.prisma.schema}.records
       WHERE child_id = ${childId}::uuid
         AND type = 'MILK'
         -- インデックス (child_id, type, started_at) を使うための粗い範囲（タイムゾーン差を含めて前後に余裕を持たせる）
         AND started_at >= ${q.from}::date - interval '1 day'
         AND started_at <  ${q.to}::date + interval '2 days'
         AND (started_at AT TIME ZONE ${q.tz})::date BETWEEN ${q.from}::date AND ${q.to}::date
       GROUP BY 1
       ORDER BY 1`;
    return rows.map((r) => ({
      date: r.date,
      totalMl: Number(r.totalMl),
      count: Number(r.count),
    }));
  }
}
