import { ServiceUnavailableException } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// ネイティブ依存（bcrypt）を避け、Vercel でもそのまま動く Node 標準の scrypt を使う
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;

// 1回あたり約32MBのメモリを使うため、同時実行数と待ち行列を制限して
// 認証 API への集中アクセスでインスタンスが落ちないようにする
const MAX_CONCURRENT = 4;
const MAX_QUEUED = 32;
let running = 0;
const queue: (() => void)[] = [];

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) {
    if (queue.length >= MAX_QUEUED) {
      throw new ServiceUnavailableException('Server busy');
    }
    await new Promise<void>((resolve) => queue.push(resolve));
  } else {
    running++;
  }
  try {
    return await task();
  } finally {
    // 待ちがあれば枠をそのまま引き継ぐ
    const next = queue.shift();
    if (next) next();
    else running--;
  }
}

// 形式: scrypt$N$r$p$salt$hash（パラメータを埋め込み、将来の強度変更に備える）
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await limited(() =>
    scryptAsync(password, salt, KEY_LEN, PARAMS),
  );
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [algo, n, r, p, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await limited(() =>
    scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: PARAMS.maxmem,
    }),
  );
  return timingSafeEqual(actual, expected);
}
