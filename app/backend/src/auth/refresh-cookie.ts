import type { Request, Response } from 'express';

/**
 * Web 版はリフレッシュトークンを JS から読めない HttpOnly Cookie で受け渡す。
 * モバイル版は従来どおり JSON 本文で受け渡す（Keychain / Keystore に保存）。
 *
 * Cookie を使うのは `X-Auth-Mode: cookie` ヘッダーがあるリクエストだけ。
 * CSRF は SameSite=Strict と、このカスタムヘッダーの要求（別オリジンからはプリフライトが必要）で防ぐ。
 * 前提: CORS で credentials を許可しないこと（app.factory.ts 参照）。
 */
export const AUTH_MODE_HEADER = 'x-auth-mode';
// __Secure- 接頭辞: Secure なしでは設定できず、兄弟サブドメインからの上書きも受けにくくする
export const REFRESH_COOKIE = '__Secure-cradle_rt';
const COOKIE_PATH = '/api/v1/auth';

export function isCookieMode(req: Request): boolean {
  return req.headers[AUTH_MODE_HEADER] === 'cookie';
}

/** 同名の Cookie が複数ある場合（他のパス・ドメインからの差し込み）は信用しない */
export function readRefreshCookie(req: Request): string | undefined {
  const values = (req.headers.cookie?.split(';') ?? [])
    .map((part) => part.trim().split('='))
    .filter(([name]) => name === REFRESH_COOKIE)
    .map(([, ...rest]) => rest.join('='));
  return values.length === 1 && values[0] ? values[0] : undefined;
}

// Secure は常に付ける（Chrome / Firefox は http://localhost も安全なオリジンとして扱う。
// Safari はローカルの http では Cookie を保存しないため、ローカル確認は Chrome で行う）
const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: COOKIE_PATH,
} as const;

export function setRefreshCookie(
  res: Response,
  token: string,
  maxAgeMs: number,
) {
  res.cookie(REFRESH_COOKIE, token, { ...cookieOptions, maxAge: maxAgeMs });
}

export function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, cookieOptions);
}
