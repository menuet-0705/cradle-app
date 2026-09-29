import { z } from 'zod';

const datetime = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
// 記録は過去の出来事なので未来は拒否する（端末の時計ずれは 5 分まで許容）
const pastDatetime = datetime.refine(
  (d) => +d <= Date.now() + 5 * 60 * 1000,
  'Must not be in the future',
);
const note = z.string().trim().max(500);

const HOUR_MS = 60 * 60 * 1000;

// IANA 名（Asia/Tokyo 等）と UTC のみ受け付ける。
// "+09:00" のようなオフセット表記は Postgres では符号が逆に解釈されるため拒否する
function isValidTimeZone(tz: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// 「1日」の区切りは利用者の地域で決まるので、端末のタイムゾーンを受け取る
// （日別集計と、体重・食事の「1 日 1 件」の判定に使う）
const timeZone = z
  .string()
  .max(64)
  .refine(isValidTimeZone, 'Invalid time zone');

// 種類ごとに必須項目が違うので、type で判別して検証する
export const createRecordSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('MILK'),
    startedAt: pastDatetime,
    amountMl: z.number().int().min(1).max(500),
    note: note.optional(),
  }),
  z
    .object({
      type: z.literal('SLEEP'),
      startedAt: pastDatetime,
      endedAt: pastDatetime,
      note: note.optional(),
    })
    .refine((v) => v.endedAt > v.startedAt, {
      message: 'endedAt must be after startedAt',
      path: ['endedAt'],
    })
    .refine((v) => +v.endedAt - +v.startedAt <= 24 * HOUR_MS, {
      message: 'Sleep must be 24 hours or less',
      path: ['endedAt'],
    }),
  z.object({
    type: z.literal('WEIGHT'),
    startedAt: pastDatetime,
    weightG: z.number().int().min(300).max(50_000),
    // 体重は 1 日 1 件（同じ日の 2 回目は上書き）
    tz: timeZone,
    note: note.optional(),
  }),
  z.object({
    type: z.literal('MEAL'),
    startedAt: pastDatetime,
    // 食事は 1 日に区分ごと 1 件（同じ日・同じ区分の 2 回目は上書き）
    mealSlot: z.enum([
      'BREAKFAST',
      'MORNING_SNACK',
      'LUNCH',
      'AFTERNOON_SNACK',
      'DINNER',
    ]),
    tz: timeZone,
    note: note.min(1),
  }),
]);
export type CreateRecordDto = z.infer<typeof createRecordSchema>;

const MAX_RANGE_DAYS = 93;

export const listRecordsSchema = z
  .object({
    from: datetime,
    to: datetime,
    type: z.enum(['MILK', 'SLEEP', 'WEIGHT', 'MEAL']).optional(),
  })
  .refine((v) => v.to > v.from, { message: 'to must be after from' })
  .refine((v) => +v.to - +v.from <= MAX_RANGE_DAYS * 24 * HOUR_MS, {
    message: `Range must be ${MAX_RANGE_DAYS} days or less`,
  });
export type ListRecordsDto = z.infer<typeof listRecordsSchema>;

export const milkDailySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    tz: timeZone,
  })
  .refine((v) => v.to >= v.from, { message: 'to must be on or after from' })
  .refine(
    (v) => +new Date(v.to) - +new Date(v.from) <= MAX_RANGE_DAYS * 24 * HOUR_MS,
    { message: `Range must be ${MAX_RANGE_DAYS} days or less` },
  );
export type MilkDailyDto = z.infer<typeof milkDailySchema>;
