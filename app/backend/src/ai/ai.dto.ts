import { z } from 'zod';

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
