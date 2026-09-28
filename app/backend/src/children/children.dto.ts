import { z } from 'zod';

const isoDate = z.iso.date(); // YYYY-MM-DD

export const createChildSchema = z.object({
  name: z.string().trim().min(1).max(50),
  birthDate: isoDate,
  sex: z.enum(['MALE', 'FEMALE']).nullish(),
  // アレルギー・避けたい食材（食事の提案で必ず除外する）。空文字は未設定として扱う
  avoidFoods: z
    .string()
    .trim()
    .max(500)
    .transform((v) => v || null)
    .nullish(),
  // 省略時は本人が最初に所属した家族
  familyId: z.uuid().optional(),
});
export type CreateChildDto = z.infer<typeof createChildSchema>;

export const updateChildSchema = createChildSchema
  .omit({ familyId: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'No fields to update');
export type UpdateChildDto = z.infer<typeof updateChildSchema>;
