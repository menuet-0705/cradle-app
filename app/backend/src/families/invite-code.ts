import { createHash, randomInt } from 'node:crypto';

// 読み間違えやすい 0/O・1/I を除いた 32 文字。10 文字で約 50 ビット
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const LENGTH = 10;

/** 新しい招待コード（区切りなし） */
export function generateInviteCode(): string {
  let code = '';
  for (let i = 0; i < LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** 入力の揺れ（小文字・ハイフン・空白）を吸収する。形式が違えば null */
export function normalizeInviteCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== LENGTH) return null;
  for (const c of code) if (!ALPHABET.includes(c)) return null;
  return code;
}

/** 表示用: K7QM-4XP2-HN */
export function formatInviteCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

/** DB にはハッシュだけを保存する */
export function hashInviteCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
