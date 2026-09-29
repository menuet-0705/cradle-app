#!/usr/bin/env node
// Claude Code 用の設定（正本）から Codex 用の設定を生成する。
//   エージェント: .llm-notes/agents/*.md → .codex/agents/*.toml
//   MCP:          .mcp.json             → .codex/config.toml（末尾のマーカー内だけ置き換え）
// .codex/agents の生成物以外の .toml と、config.toml のマーカー外の設定はそのまま残す。
// 使い方: node .llm-notes/sync.mjs          生成する
//         node .llm-notes/sync.mjs --check  生成物が最新でなければ終了コード 1
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentsSrc = join(root, ".llm-notes/agents");
const agentsDst = join(root, ".codex/agents");
const mcpSrc = join(root, ".mcp.json");
const codexConfig = join(root, ".codex/config.toml");

const HEADER = "# 生成物: 手で編集しない。正本を直して `node .llm-notes/sync.mjs` を実行する\n";
const MCP_BEGIN = "# >>> generated from .mcp.json (node .llm-notes/sync.mjs)";
const MCP_END = "# <<< generated from .mcp.json";
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"];

const check = process.argv.includes("--check");

const NAME = /^[A-Za-z0-9_-]+$/;

// TOML で文字のまま書けない制御文字（タブ・改行以外）と DEL を \uXXXX にする
const escapeControl = (s) =>
  s.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
function checkText(s) {
  if (!String(s).isWellFormed()) throw new Error(`対になっていないサロゲートを含む文字列は TOML に書けません: ${s}`);
  return String(s);
}
// TOML の基本文字列（1 行）。JSON のエスケープは DEL 以外 TOML でも有効
const str = (s) => escapeControl(JSON.stringify(checkText(s)));
// TOML の複数行基本文字列
const multiline = (s) => `"""\n${escapeControl(checkText(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"'))}"""`;
// TOML のキー（英数字・_・- 以外を含むときは引用する）
const key = (s) => (NAME.test(s) ? s : str(s));

// frontmatter の値。単純な文字列・引用符付き文字列・[a, b] の配列だけを扱う
function yamlValue(file, k, v) {
  if (/^[>|]/.test(v)) throw new Error(`${file}: ${k} の複数行の値（> や |）には未対応です`);
  const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(",").map(unquote).filter(Boolean);
  return unquote(v);
}

function parseAgent(file) {
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: frontmatter がありません`);
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = yamlValue(file, line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  if (!meta.name || !meta.description) throw new Error(`${file}: name と description が必要です`);
  if (!NAME.test(meta.name)) throw new Error(`${file}: name は英数字・_・- だけにしてください（${meta.name}）`);
  const tools = (Array.isArray(meta.tools) ? meta.tools : (meta.tools ?? "").split(","))
    .map((t) => t.trim())
    .filter(Boolean);
  // tools 未指定は Claude では全ツール許可なので、書き込み可として扱う
  const readOnly = tools.length > 0 && !tools.some((t) => WRITE_TOOLS.includes(t));
  return { name: meta.name, description: meta.description, readOnly, body: m[2].trim() + "\n" };
}

function agentToml(a) {
  return [
    HEADER,
    `name = ${str(a.name)}`,
    `description = ${str(a.description)}`,
    `sandbox_mode = ${str(a.readOnly ? "read-only" : "workspace-write")}`,
    `developer_instructions = ${multiline(a.body)}`,
    "",
  ].join("\n");
}

function mcpToml() {
  const { mcpServers = {} } = JSON.parse(readFileSync(mcpSrc, "utf8"));
  const lines = [MCP_BEGIN];
  for (const [name, s] of Object.entries(mcpServers)) {
    if (s.type && s.type !== "stdio") throw new Error(`MCP ${name}: stdio 以外（${s.type}）は未対応です`);
    if (!s.command) throw new Error(`MCP ${name}: command がありません`);
    lines.push("", `[mcp_servers.${key(name)}]`, `command = ${str(s.command)}`);
    if (s.args?.length) lines.push(`args = [${s.args.map(str).join(", ")}]`);
    // 値をそのまま書くと秘密がコミット対象の config.toml に複製されるので、${NAME}（親プロセスから引き継ぐ）だけを許す
    const envVars = Object.entries(s.env ?? {}).map(([k, v]) => {
      if (v !== `\${${k}}`) throw new Error(`MCP ${name}: env.${k} は "\${${k}}" の形で書いてください（値を直接書かない）`);
      return k;
    });
    if (envVars.length) lines.push(`env_vars = [${envVars.map(str).join(", ")}]`);
  }
  lines.push("", MCP_END);
  return lines.join("\n");
}

// 生成ブロックは常にファイル末尾に置く（後ろにトップレベルのキーを書くと MCP テーブルの中身と解釈されるため）
function withMcp(current) {
  const b = current.indexOf(MCP_BEGIN);
  const e = current.indexOf(MCP_END);
  if ((b >= 0) !== (e >= 0) || e < b) throw new Error(".codex/config.toml の生成マーカーの対応が壊れています");
  let rest = b >= 0 ? current.slice(0, b) + current.slice(e + MCP_END.length) : current;
  if (/\[mcp_servers[.\]]/.test(rest)) {
    throw new Error(".codex/config.toml にマーカー外の [mcp_servers] があります。.mcp.json に移してから削除してください");
  }
  rest = rest.trim();
  return (rest ? rest + "\n\n" : "") + mcpToml() + "\n";
}

// 期待する内容を組み立てる（パス → 内容。null は削除）
const expected = new Map();
const agentNames = new Set();
for (const f of readdirSync(agentsSrc).filter((f) => f.endsWith(".md")).sort()) {
  const a = parseAgent(join(agentsSrc, f));
  if (agentNames.has(a.name)) throw new Error(`エージェント名 ${a.name} が重複しています`);
  agentNames.add(a.name);
  expected.set(join(agentsDst, `${a.name}.toml`), agentToml(a));
}
for (const f of existsSync(agentsDst) ? readdirSync(agentsDst) : []) {
  const p = join(agentsDst, f);
  // 正本から消えたエージェント（手で置いた Codex 専用のものは残す）
  if (f.endsWith(".toml") && !expected.has(p) && readFileSync(p, "utf8").startsWith(HEADER)) expected.set(p, null);
}
expected.set(codexConfig, withMcp(existsSync(codexConfig) ? readFileSync(codexConfig, "utf8") : ""));

const stale = [];
for (const [p, content] of expected) {
  const current = existsSync(p) ? readFileSync(p, "utf8") : null;
  if (current === content) continue;
  stale.push(p.slice(root.length + 1));
  if (check) continue;
  if (content === null) unlinkSync(p);
  else {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

if (check && stale.length) {
  console.error(`生成物が古くなっています: ${stale.join(", ")}\n→ node .llm-notes/sync.mjs を実行してください`);
  process.exit(1);
}
console.log(stale.length ? `更新: ${stale.join(", ")}` : "変更なし");
