import { z } from 'zod';
import { timeZoneSchema } from '../records/records.dto.js';

/** グラフの種類（パスでは小文字: weight / milk） */
export const chartParamSchema = z
  .enum(['weight', 'milk'])
  .transform((v) => (v === 'weight' ? 'WEIGHT' : 'MILK') as 'WEIGHT' | 'MILK');
export type ChartParam = z.infer<typeof chartParamSchema>;

/** 「今日」を区切る端末のタイムゾーン */
export const chartCommentQuerySchema = z.object({ tz: timeZoneSchema });
export type ChartCommentQuery = z.infer<typeof chartCommentQuerySchema>;

export const listWeeklyReportsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(52).default(10),
});
export type ListWeeklyReportsDto = z.infer<typeof listWeeklyReportsSchema>;

export const updateNotificationSettingsSchema = z.strictObject({
  weeklyReportEmail: z.boolean(),
});
export type UpdateNotificationSettingsDto = z.infer<
  typeof updateNotificationSettingsSchema
>;
