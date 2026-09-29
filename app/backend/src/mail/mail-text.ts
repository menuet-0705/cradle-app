/** メール本文に利用者の入力を埋め込むときの無害化 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

// 制御文字と、表示順を入れ替えたり見えない文字を差し込んだりできる文字（なりすまし文面対策）
const UNSAFE_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

// 利用者が入力した名前は改行・制御文字を除き、長さも抑える（件名への注入・なりすまし文面対策）
export const plain = (s: string, max = 50) =>
  s.replace(UNSAFE_CHARS, ' ').trim().slice(0, max);
