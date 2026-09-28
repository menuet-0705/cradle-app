import type { PrismaService } from '../prisma/prisma.service.js';

// Claude に渡す前の集計。数値の計算はここで行い、LLM には計算させない。
// こどもの名前・家族の情報は含めない（月齢・性別・記録のみ）

const TZ = 'Asia/Tokyo';
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const dateFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }); // YYYY-MM-DD
const timeFmt = new Intl.DateTimeFormat('ja-JP', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  // hour12: false だと環境によって深夜 0 時が「24:xx」になるため h23 を明示する
  hourCycle: 'h23',
});
const weekdayFmt = new Intl.DateTimeFormat('ja-JP', {
  timeZone: TZ,
  weekday: 'short',
});

export const jstDate = (d: Date) => dateFmt.format(d);
const jstTime = (d: Date) => timeFmt.format(d);
const jstDateLabel = (d: Date) => `${jstDate(d)}(${weekdayFmt.format(d)})`;

/** 日本時間の 0 時 */
export function jstStartOfDay(d: Date): Date {
  const local = d.getTime() + JST_OFFSET_MS;
  return new Date(local - (local % DAY_MS) - JST_OFFSET_MS);
}

/**
 * 週次レポートの対象期間: 直近の「金曜 17:00 JST」までの 7 日間。
 * Cron が遅れて実行されても、同じ週なら同じ期間になる（重複作成の防止にも使う）
 */
export function reportPeriod(now: Date): { start: Date; end: Date } {
  const local = new Date(now.getTime() + JST_OFFSET_MS); // UTC の値として JST の時刻を読む
  const friday17 = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() - ((local.getUTCDay() - 5 + 7) % 7),
    17,
  );
  let endLocal = friday17;
  if (endLocal > local.getTime()) endLocal -= 7 * DAY_MS;
  const end = new Date(endLocal - JST_OFFSET_MS);
  return { start: new Date(end.getTime() - 7 * DAY_MS), end };
}

export function ageInMonths(birthDate: Date, at: Date): number {
  const b = new Date(birthDate); // DB の date は UTC 0 時
  const a = new Date(at.getTime() + JST_OFFSET_MS);
  let months =
    (a.getUTCFullYear() - b.getUTCFullYear()) * 12 +
    a.getUTCMonth() -
    b.getUTCMonth();
  if (a.getUTCDate() < b.getUTCDate()) months--;
  return Math.max(0, months);
}

function nextMealLabel(now: Date): string {
  const hour = Number(jstTime(now).slice(0, 2));
  if (hour < 10) return '朝食';
  if (hour < 14) return '昼食';
  if (hour < 20) return '夕食';
  return '翌日の朝食';
}

const AMOUNT: Record<string, string> = {
  ALL: 'ぜんぶ',
  HALF: '半分くらい',
  LITTLE: '少し',
  NONE: '食べなかった',
};
const REACTION: Record<string, string> = {
  LIKED: '好き',
  NEUTRAL: 'ふつう',
  DISLIKED: '苦手',
};

interface ChildInfo {
  birthDate: Date;
  sex: 'MALE' | 'FEMALE' | null;
  avoidFoods: string | null;
}

const childProfile = (child: ChildInfo, now: Date) => ({
  ageMonths: ageInMonths(child.birthDate, now),
  sex:
    child.sex === 'MALE'
      ? '男の子'
      : child.sex === 'FEMALE'
        ? '女の子'
        : '未設定',
  avoidFoods: clip(child.avoidFoods, MAX_AVOID_FOODS) || 'なし',
});

// Claude に渡す入力の上限（費用が際限なく増えないように）。
// 1 か月分でも直近 60 食、メモは 1 件 100 文字、避けたい食材は 200 文字までに切り詰める
const MAX_MEALS = 60;
const MAX_NOTE = 100;
const MAX_AVOID_FOODS = 200;
const MAX_MEALS_PER_DAY = 8;
const clip = (s: string | null, max: number) =>
  s && s.length > max ? `${s.slice(0, max)}…` : (s ?? '');

export async function buildMealSuggestionInput(
  prisma: PrismaService,
  childId: string,
  now: Date,
) {
  const child = await prisma.child.findUniqueOrThrow({
    where: { id: childId },
    select: { birthDate: true, sex: true, avoidFoods: true },
  });
  const [meals, milk] = await Promise.all([
    prisma.record.findMany({
      where: {
        childId,
        type: 'MEAL',
        startedAt: { gte: new Date(now.getTime() - 30 * DAY_MS), lte: now },
      },
      orderBy: { startedAt: 'desc' },
      take: MAX_MEALS,
      select: {
        startedAt: true,
        note: true,
        mealAmount: true,
        mealReaction: true,
      },
    }),
    prisma.record.aggregate({
      where: {
        childId,
        type: 'MILK',
        startedAt: { gte: new Date(now.getTime() - 7 * DAY_MS), lte: now },
      },
      _sum: { amountMl: true },
      _count: true,
    }),
  ]);

  return {
    today: jstDateLabel(now),
    nextMeal: nextMealLabel(now),
    child: childProfile(child, now),
    milkLast7Days: {
      averageMlPerDay: Math.round((milk._sum.amountMl ?? 0) / 7),
      averageTimesPerDay: Math.round((milk._count / 7) * 10) / 10,
    },
    mealsLast30Days: meals.reverse().map((m) => ({
      date: jstDateLabel(m.startedAt),
      time: jstTime(m.startedAt),
      food: clip(m.note, MAX_NOTE),
      amount: m.mealAmount ? AMOUNT[m.mealAmount] : '未記録',
      reaction: m.mealReaction ? REACTION[m.mealReaction] : '未記録',
    })),
  };
}
export type MealSuggestionInput = Awaited<
  ReturnType<typeof buildMealSuggestionInput>
>;

interface DayStats {
  /** 期間の境目（金曜 17:00）で途中までしか含まない日。1 日あたりの平均には使わない */
  partial: boolean;
  milkMl: number;
  milkTimes: number;
  sleepMinutes: number;
  sleepTimes: number;
  meals: { time: string; food: string; amount: string; reaction: string }[];
}

async function weekStats(
  prisma: PrismaService,
  childId: string,
  start: Date,
  end: Date,
) {
  const records = await prisma.record.findMany({
    where: { childId, startedAt: { gte: start, lt: end } },
    orderBy: { startedAt: 'asc' },
    take: 2000,
    select: {
      type: true,
      startedAt: true,
      endedAt: true,
      amountMl: true,
      weightG: true,
      note: true,
      mealAmount: true,
      mealReaction: true,
    },
  });
  const days = new Map<string, DayStats>();
  // 期間内の全日を並べる（記録がない日も「記録なし」と分かるように）。
  // 期間は金曜 17:00 始まりなので、開始日の 0 時から数えて最初と最後の金曜も含める（計 8 日）
  for (let t = jstStartOfDay(start).getTime(); t < end.getTime(); t += DAY_MS) {
    days.set(jstDateLabel(new Date(t)), {
      partial: t < start.getTime() || t + DAY_MS > end.getTime(),
      milkMl: 0,
      milkTimes: 0,
      sleepMinutes: 0,
      sleepTimes: 0,
      meals: [],
    });
  }
  const weights: { date: string; kg: number }[] = [];
  for (const r of records) {
    const day = days.get(jstDateLabel(r.startedAt));
    if (!day) continue;
    switch (r.type) {
      case 'MILK':
        day.milkMl += r.amountMl ?? 0;
        day.milkTimes++;
        break;
      case 'SLEEP':
        if (r.endedAt) {
          day.sleepMinutes += Math.round((+r.endedAt - +r.startedAt) / 60000);
        }
        day.sleepTimes++;
        break;
      case 'MEAL':
        if (day.meals.length >= MAX_MEALS_PER_DAY) break;
        day.meals.push({
          time: jstTime(r.startedAt),
          food: clip(r.note, MAX_NOTE),
          amount: r.mealAmount ? AMOUNT[r.mealAmount] : '未記録',
          reaction: r.mealReaction ? REACTION[r.mealReaction] : '未記録',
        });
        break;
      case 'WEIGHT':
        if (r.weightG) {
          weights.push({
            date: jstDateLabel(r.startedAt),
            kg: r.weightG / 1000,
          });
        }
        break;
    }
  }
  return { days, weights, recordCount: records.length };
}

const average = (xs: number[]) =>
  xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;

export async function buildWeeklyReportInput(
  prisma: PrismaService,
  childId: string,
  period: { start: Date; end: Date },
) {
  const child = await prisma.child.findUniqueOrThrow({
    where: { id: childId },
    select: { birthDate: true, sex: true, avoidFoods: true },
  });
  const prevStart = new Date(period.start.getTime() - 7 * DAY_MS);
  const [thisWeek, lastWeek, lastWeightBefore] = await Promise.all([
    weekStats(prisma, childId, period.start, period.end),
    weekStats(prisma, childId, prevStart, period.start),
    prisma.record.findFirst({
      where: { childId, type: 'WEIGHT', startedAt: { lt: period.start } },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, weightG: true },
    }),
  ]);

  // 平均は「丸 1 日含まれる日のうち、その種類の記録がある日」だけで出す
  // （睡眠だけ記録した日や、期間の境目の半日でミルクの平均が下がらないように）
  const summarize = (s: typeof thisWeek) => {
    const days = [...s.days.values()];
    const fullDays = days.filter((d) => !d.partial);
    const milkDays = fullDays.filter((d) => d.milkTimes > 0);
    const sleepDays = fullDays.filter((d) => d.sleepTimes > 0);
    return {
      fullDaysWithRecords: fullDays.filter(
        (d) => d.milkTimes + d.sleepTimes + d.meals.length > 0,
      ).length,
      averageMilkMlOnDaysWithMilk: average(milkDays.map((d) => d.milkMl)),
      averageSleepMinutesOnDaysWithSleep: average(
        sleepDays.map((d) => d.sleepMinutes),
      ),
      mealCount: days.reduce((n, d) => n + d.meals.length, 0),
    };
  };

  return {
    period: `${jstDateLabel(period.start)} 17:00 〜 ${jstDateLabel(period.end)} 17:00`,
    child: childProfile(child, period.end),
    thisWeek: {
      summary: summarize(thisWeek),
      days: Object.fromEntries(thisWeek.days),
      weights: thisWeek.weights,
    },
    lastWeek: summarize(lastWeek),
    weightBeforeThisWeek:
      lastWeightBefore?.weightG != null
        ? {
            date: jstDateLabel(lastWeightBefore.startedAt),
            kg: lastWeightBefore.weightG / 1000,
          }
        : null,
  };
}
export type WeeklyReportInput = Awaited<
  ReturnType<typeof buildWeeklyReportInput>
>;
