#!/usr/bin/env node
// PreToolUse フック: .env / .env.keys などの秘密ファイルの参照と、秘密を復号・表示するコマンドを止める。
// settings.json の deny は Read ツールにしか効かず、Bash の `cat .env` などは素通りするため、その穴を塞ぐ。
// .env.example（キー一覧のみ）は許可する。
// 変数展開やクォート分割（`.e''nv`）などの意図的な回避は正規表現では止めきれない。偶発的な参照を防ぐためのもの。
// 終了コード 2 でツール実行を拒否し、stderr を Claude に返す。
// 入力が読めないなどの異常時も拒否する（終了コード 2 以外はツールがそのまま実行されるため）。
import { readFileSync } from "node:fs";

// `.env` の出現（前が英数字・$ でないもの。process.env などは除外）と、ファイル名・glob に使える文字の続き
const SECRET_FILE = /(?<![\w$])\.env([\w.*?[\]{},~+@%-]*)/gi;
// `.env` を書かずに当たりうる glob（`.*` `.e*` `.en[v]` など）
const DOT_GLOB = /(?:^|[\s/'"=])\.(?:e\w*)?[*?[]/i;
// 秘密を復号・表示するコマンド、.gitignore を無視してファイル名なしで中身を出す検索
const SECRET_COMMANDS = [
  /\bdotenvx\b[^;&|\n]*\b(?:run|get|decrypt|keypair)\b/,
  /\bprintenv\b/,
  // コマンドを指定しない env（一覧表示）。`env -u FOO` も残りを表示する
  /(?:^|[;&|(]\s*)(?:\S*\/)?env(?:\s+-\S+(?:\s+[A-Za-z_]\w*(?=\s|$))?)*\s*(?:$|[;&|)<>])/,
  /\/proc\/\w+\/environ\b/,
  /(?:^|[;&|(]\s*)(?:set|export)\s*(?:$|[;&|)<>])/, // 引数なしの set / export
  /\bexport\s+-p\b|\b(?:declare|typeset)\s+-[a-zA-Z]*[px]/,
  /dotenv\/config|\brequire\(\s*['"]dotenv['"]\s*\)|\bfrom\s+['"]dotenv['"]/,
  /\bnode\b[^;&|\n]*\s(?:-p|-e|--print|--eval)\b[^;&|\n]*process\.env/,
  /\b[ef]?grep\b[^;&|\n]*\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive|-d\s*recurse|--directories=recurse)(?=\s|$)/,
  /\brg\b[^;&|\n]*\s(?:-[a-zA-Z]*u[a-zA-Z]*|--no-ignore[\w-]*|--hidden|-\.)(?=\s|$)/,
  /\bgit\s+grep\b[^;&|\n]*--no-(?:index|exclude-standard)\b/,
  // find/xargs 経由の読み出し（ファイル名を書かずに中身を読む形）
  /(?:\bxargs|\s-exec(?:dir)?)\s+(?:-\S+\s+)*(?:\S*\/)?(?:[ef]?grep|rg|cat|head|tail|less|more|sed|awk|strings)\b/,
];

function findSecret(tool, t) {
  // Grep の pattern は検索する文字列（ファイル名ではない）なので見ない。Glob の pattern はファイル名
  const target = [t.command, t.file_path, t.notebook_path, t.path, t.glob, tool === "Glob" && t.pattern]
    .filter(Boolean)
    .join("\n");
  for (const [ref, rest] of target.matchAll(SECRET_FILE)) {
    if (/^\w/.test(rest)) continue; // .envrc など別ファイル
    if (/^\.example$/i.test(rest)) continue;
    return ref;
  }
  const glob = target.match(DOT_GLOB);
  if (glob) return glob[0].trim();
  if (t.command) {
    for (const re of SECRET_COMMANDS) {
      const m = t.command.match(re);
      if (m) return m[0].trim();
    }
  }
  return null;
}

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const blocked = findSecret(input.tool_name, input.tool_input ?? {});
  if (blocked) {
    console.error(
      `秘密情報の保護のため拒否しました（${blocked}）。.env / .env.keys は読まず、キー一覧は .env.example を参照してください。` +
        "再帰検索は .gitignore を尊重する Grep ツールか rg（-u / --hidden なし）を使ってください。",
    );
    process.exit(2);
  }
} catch (e) {
  console.error(`block-secrets フックの処理に失敗したため拒否しました: ${e.message}`);
  process.exit(2);
}
