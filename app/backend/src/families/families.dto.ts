import { z } from 'zod';

export const createInviteSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
});
export type CreateInviteDto = z.infer<typeof createInviteSchema>;

// 形式の検証は normalizeInviteCode で行う（ここでは長さの上限だけ）
export const inviteCodeSchema = z.object({
  code: z.string().min(1).max(40),
});
export type InviteCodeDto = z.infer<typeof inviteCodeSchema>;
