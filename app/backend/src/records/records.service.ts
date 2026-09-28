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
  mealAmount: true,
  mealReaction: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
} as const;

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
      orderBy: { startedAt: 'desc' },
      take: 1000,
    });
  }

  async create(userId: string, childId: string, dto: CreateRecordDto) {
    await this.children.assertAccess(userId, childId);
    return this.prisma.record.create({
      data: {
        childId,
        createdById: userId,
        type: dto.type,
        startedAt: dto.startedAt,
        endedAt: dto.type === 'SLEEP' ? dto.endedAt : null,
        amountMl: dto.type === 'MILK' ? dto.amountMl : null,
        weightG: dto.type === 'WEIGHT' ? dto.weightG : null,
        note: dto.note ?? null,
        mealAmount: dto.type === 'MEAL' ? (dto.mealAmount ?? null) : null,
        mealReaction: dto.type === 'MEAL' ? (dto.mealReaction ?? null) : null,
      },
      select: recordSelect,
    });
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
