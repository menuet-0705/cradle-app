import { escapeHtml, plain } from '../mail/mail-text.js';
import type { MailMessage } from '../mail/mailer.js';

const MAX_NAMES = 3;
const MAX_NAME_LENGTH = 20;

interface ReportMailInput {
  to: string;
  /** レポートができたこどもの名前（同じ利用者宛ては 1 通にまとめる） */
  childNames: string[];
  appUrl: string;
}

/**
 * 習慣レポート完成のお知らせ。
 * レポートの中身は載せない（転送・誤送信で成長記録が外に出ないように）。アプリで確認してもらう
 */
export function buildReportMail(input: ReportMailInput): MailMessage {
  // 利用者が入力した名前は数と長さを抑える（確認していないアドレスに任意の文を大量に送らせない）
  const names = input.childNames
    .slice(0, MAX_NAMES)
    .map((n) => `${plain(n, MAX_NAME_LENGTH)}さん`);
  const others = input.childNames.length - names.length;
  const who = names.join('、') + (others > 0 ? ` ほか ${others} 人` : '');

  const text = [
    `${who}の 1 週間をふりかえる「習慣レポート」ができました。`,
    'アプリの「AIによる分析」タブで、よかった点・気になる点・傾向を確認できます。',
    '',
    input.appUrl,
    '',
    '・レポートは AI による参考情報です。体調の心配は医師・保健師に相談してください',
    '・このお知らせが不要な場合は、「AIによる分析」タブの設定でオフにできます',
    '',
    '---',
    'すくすく記録',
  ].join('\n');

  const html = `<!doctype html>
<html lang="ja"><body style="font-family:sans-serif;line-height:1.7;color:#222">
<p>${escapeHtml(who)}の 1 週間をふりかえる「習慣レポート」ができました。<br>
アプリの「AIによる分析」タブで、よかった点・気になる点・傾向を確認できます。</p>
<p><a href="${escapeHtml(input.appUrl)}" style="display:inline-block;padding:10px 20px;background:#e76f51;color:#fff;text-decoration:none;border-radius:6px">レポートを見る</a></p>
<ul style="color:#555;font-size:13px">
<li>レポートは AI による参考情報です。体調の心配は医師・保健師に相談してください</li>
<li>このお知らせが不要な場合は、「AIによる分析」タブの設定でオフにできます</li>
</ul>
<p style="color:#888;font-size:12px">すくすく記録</p>
</body></html>`;

  return {
    to: input.to,
    // 件名には利用者が入力した文字列を入れない（送信元ドメインを使った迷惑メールに悪用させない）
    subject: '今週の習慣レポートができました（すくすく記録）',
    text,
    html,
  };
}
