import type { MailMessage } from '../mail/mailer.js';

// 制御文字と、表示順を入れ替えたり見えない文字を差し込んだりできる文字（なりすまし文面対策）
const UNSAFE_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g;
const plain = (s: string, max = 50) =>
  s.replace(UNSAFE_CHARS, ' ').trim().slice(0, max);

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/**
 * 週次レポートの完成通知。宛先は同じ家族のメンバーだけ。
 * レポートの本文（健康に関わる内容）はメールに載せず、アプリで見てもらう
 */
export function buildWeeklyReportMail(input: {
  to: string;
  childName: string;
  appUrl: string;
}): MailMessage {
  const child = plain(input.childName);
  const link = `${input.appUrl}/`;
  const text = [
    `${child}さんの今週のふりかえりレポートができました。`,
    'アプリの「ふりかえり」タブから確認できます。',
    '',
    link,
    '',
    '---',
    'すくすく記録',
    'このメールは、家族として登録されている方にお送りしています。',
  ].join('\n');
  const html = `<!doctype html>
<html lang="ja"><body style="font-family:sans-serif;line-height:1.7;color:#222">
<p>${escapeHtml(child)}さんの今週のふりかえりレポートができました。<br>
アプリの「ふりかえり」タブから確認できます。</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 20px;background:#e76f51;color:#fff;text-decoration:none;border-radius:6px">アプリを開く</a></p>
<p style="color:#888;font-size:12px">すくすく記録<br>このメールは、家族として登録されている方にお送りしています。</p>
</body></html>`;
  return {
    to: input.to,
    // 件名には利用者の入力（こどもの名前）を入れない
    subject: '今週のふりかえりレポートができました',
    text,
    html,
  };
}
