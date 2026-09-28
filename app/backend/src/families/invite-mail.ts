import type { MailMessage } from '../mail/mailer.js';
import { formatInviteCode } from './invite-code.js';

interface InviteMailInput {
  to: string;
  inviterName: string;
  familyName: string;
  code: string;
  appUrl: string;
  expiresAt: Date;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

// 制御文字と、表示順を入れ替えたり見えない文字を差し込んだりできる文字（なりすまし文面対策）
const UNSAFE_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

// 利用者が入力した名前は改行・制御文字を除き、長さも抑える（件名への注入・なりすまし文面対策）
const plain = (s: string, max = 50) =>
  s.replace(UNSAFE_CHARS, ' ').trim().slice(0, max);

export function buildInviteMail(input: InviteMailInput): MailMessage {
  const inviter = plain(input.inviterName);
  const family = plain(input.familyName);
  const code = formatInviteCode(input.code);
  // コードは # 以降に置く（サーバーに送られず、アクセスログに残らない）
  const link = `${input.appUrl}/invite#${input.code}`;
  const expires = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(input.expiresAt);

  const text = [
    `${inviter}さんから「${family}」への招待が届きました。`,
    '参加すると、こどもの成長記録を一緒に見たり記録したりできます。',
    '',
    '▼ ブラウザで参加する',
    link,
    '',
    '▼ アプリで参加する',
    `メニューの「招待コードを入力」に次のコードを入力してください: ${code}`,
    '',
    `・このメールアドレス（${input.to}）でログインまたは新規登録すると参加できます`,
    `・有効期限: ${expires}（1 回限り）`,
    '・心当たりがない場合は、このメールを破棄してください',
    '',
    '---',
    'すくすく記録',
  ].join('\n');

  const html = `<!doctype html>
<html lang="ja"><body style="font-family:sans-serif;line-height:1.7;color:#222">
<p>${escapeHtml(inviter)}さんから「${escapeHtml(family)}」への招待が届きました。<br>
参加すると、こどもの成長記録を一緒に見たり記録したりできます。</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 20px;background:#e76f51;color:#fff;text-decoration:none;border-radius:6px">ブラウザで参加する</a></p>
<p>アプリの場合は、メニューの「招待コードを入力」に次のコードを入力してください。<br>
<strong style="font-size:20px;letter-spacing:2px">${escapeHtml(code)}</strong></p>
<ul style="color:#555;font-size:13px">
<li>このメールアドレス（${escapeHtml(input.to)}）でログインまたは新規登録すると参加できます</li>
<li>有効期限: ${escapeHtml(expires)}（1 回限り）</li>
<li>心当たりがない場合は、このメールを破棄してください</li>
</ul>
<p style="color:#888;font-size:12px">すくすく記録</p>
</body></html>`;

  return {
    to: input.to,
    // 件名には利用者が入力した文字列を入れない（送信元ドメインを使った迷惑メールに悪用させない）
    subject: '「すくすく記録」の家族への招待が届きました',
    text,
    html,
  };
}
