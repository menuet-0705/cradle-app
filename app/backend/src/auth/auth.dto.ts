import { z } from 'zod';

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const signupSchema = z.object({
  email,
  // scrypt の負荷を抑えるため上限を設ける
  password: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(50),
});
export type SignupDto = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
});
export type LoginDto = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(200),
});
