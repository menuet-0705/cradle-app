import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ChildrenService } from '../children/children.service.js';
import { Prisma } from '../generated/prisma/client.js';
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
  mealSlot: true,
  note: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
} as const;

// 同じこどもへの同時保存はロックで順番待ちになるので、既定（2 秒）より長く待つ
const TX_OPTIONS = { maxWait: 5000, timeout: 5000 };

/** 体重・食事（1 日 1 件。食事は区分ごと） */
type OncePerDayDto = Extract<CreateRecordDto, { type: 'WEIGHT' | 'MEAL' }>;

/** 種類ごとの項目。その種類で使わない項目は null にする（CHECK 制約と合わせる） */
function recordFields(dto: CreateRecordDto) {
  return {
    startedAt: dto.startedAt,
    endedAt: dto.type === 'SLEEP' ? dto.endedAt : null,
    amountMl: dto.type === 'MILK' ? dto.amountMl : null,
    weightG: dto.type === 'WEIGHT' ? dto.weightG : null,
    mealSlot: dto.type === 'MEAL' ? dto.mealSlot : null,
    note: dto.note ?? null,
  };
}

/** tz（検証済みの IANA 名）での日付（YYYY-MM-DD） */
function localDate(at: Date, tz: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at);
}

/**
 * 体重・食事の「1 日 1 件」の確認と保存を、同時リクエストで追い越されないよう
 * こどもごとに 1 件ずつ行うためのロック（トランザクションの終わりで外れる）
 */
async function lockChild(tx: Prisma.TransactionClient, childId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('records:daily:' || ${childId}))`;
}

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
      // 同じ時刻なら後から作った方を先に（体重・食事の上書き対象と同じ順）
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
      take: 1000,
    });
  }

  async create(userId: string, childId: string, dto: CreateRecordDto) {
    await this.children.assertAccess(userId, childId);
    if (dto.type === 'WEIGHT' || dto.type === 'MEAL') {
      return this.saveOncePerDay(userId, childId, dto);
    }
    return this.prisma.record.create({
      data: {
        ...recordFields(dto),
        childId,
        createdById: userId,
        type: dto.type,
      },
      select: recordSelect,
    });
  }

  /**
   * 体重は 1 日 1 件、食事は 1 日に区分ごと 1 件。同じ日（dto.tz で区切る）にすでにあれば、
   * その記録を上書きする
   */
  private saveOncePerDay(userId: string, childId: string, dto: OncePerDayDto) {
    return this.prisma.$transaction(async (tx) => {
      await lockChild(tx, childId);
      const existing = await this.findSameDay(tx, childId, dto);
      return existing
        ? tx.record.update({
            where: { id: existing },
            data: recordFields(dto),
            select: recordSelect,
          })
        : tx.record.create({
            data: {
              ...recordFields(dto),
              childId,
              createdById: userId,
              type: dto.type,
            },
            select: recordSelect,
          });
    }, TX_OPTIONS);
  }

  /**
   * 記録の修正。種類は変えられない。体重・食事を、別の記録がある日（・区分）に移すことはできない
   * （上書きはしない）。記録者は変えない
   */
  async update(userId: string, recordId: string, dto: CreateRecordDto) {
    // 所属家族のこどもの記録だけを修正対象にする（更新の条件にも入れ、確認後に家族から外れた場合も更新させない）
    const owned = {
      id: recordId,
      child: { family: { members: { some: { userId } } } },
    };
    const current = await this.prisma.record.findFirst({
      where: owned,
      select: { childId: true, type: true, startedAt: true, mealSlot: true },
    });
    if (!current) throw new NotFoundException('Record not found');
    if (current.type !== dto.type) {
      throw new BadRequestException({
        message: 'Record type cannot be changed',
        code: 'TYPE_MISMATCH',
      });
    }
    const save = (tx: Prisma.TransactionClient) =>
      tx.record.update({
        where: owned,
        data: recordFields(dto),
        select: recordSelect,
      });
    try {
      if (dto.type !== 'WEIGHT' && dto.type !== 'MEAL') {
        return await save(this.prisma);
      }
      // 日付・区分を変えない修正は重複の確認をしない（以前から同じ日に重複している記録も値を直せるように）
      const moved =
        localDate(current.startedAt, dto.tz) !==
          localDate(dto.startedAt, dto.tz) ||
        current.mealSlot !== (dto.type === 'MEAL' ? dto.mealSlot : null);
      if (!moved) return await save(this.prisma);
      return await this.prisma.$transaction(async (tx) => {
        await lockChild(tx, current.childId);
        if (await this.findSameDay(tx, current.childId, dto, recordId)) {
          throw new ConflictException({
            message: 'Another record already exists on that day',
            code: 'DUPLICATE_RECORD',
          });
        }
        return save(tx);
      }, TX_OPTIONS);
    } catch (e) {
      // 確認の後に削除された
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        throw new NotFoundException('Record not found');
      }
      throw e;
    }
  }

  /**
   * 同じこども・同じ日（dto.tz で区切る）・同じ種類（食事は同じ区分）の記録を 1 件探す。
   * 過去に同じ日に複数登録されている場合は、最も新しい 1 件を返す
   */
  private async findSameDay(
    tx: Prisma.TransactionClient,
    childId: string,
    dto: OncePerDayDto,
    excludeId?: string,
  ): Promise<string | undefined> {
    const startedAt = dto.startedAt.toISOString();
    const mealSlot = dto.type === 'MEAL' ? dto.mealSlot : null;
    const schema = this.prisma.schema;
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id
        FROM ${schema}.records
       WHERE child_id = ${childId}::uuid
         AND type = CAST(${dto.type} AS ${schema}."RecordType")
         AND meal_slot IS NOT DISTINCT FROM CAST(${mealSlot} AS ${schema}."MealSlot")
         ${excludeId ? Prisma.sql`AND id <> ${excludeId}::uuid` : Prisma.empty}
         -- インデックス (child_id, type, started_at) を使うための粗い範囲（夏時間で 1 日が 25 時間の日も含める）
         AND started_at >= ${startedAt}::timestamptz - interval '26 hours'
         AND started_at <  ${startedAt}::timestamptz + interval '26 hours'
         AND (started_at AT TIME ZONE ${dto.tz})::date
           = (${startedAt}::timestamptz AT TIME ZONE ${dto.tz})::date
       ORDER BY started_at DESC, created_at DESC
       LIMIT 1`;
    return row?.id;
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
    return this.milkDailyOf(childId, q);
  }

  /** 1 日ごとのミルクの合計（権限の確認は呼び出し側で済ませる。グラフの AI コメントも使う） */
  async milkDailyOf(childId: string, q: MilkDailyDto) {
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
