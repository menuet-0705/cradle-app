# 20260929 Claude Code / Codex の設定共有

Claude Code と Codex を併用するため、秘密情報の読み取り禁止を強化し、形式が違う設定（エージェント・MCP）を 1 か所の正本から生成してずれを防ぐ。

## 方針
- 正本
  - エージェント: `.llm-notes/agents/*.md`（Claude 形式。`.claude/agents` はこのディレクトリへのシンボリックリンク）
  - MCP: `.mcp.json`（Claude 形式）
- 生成物（手で編集しない。ファイル先頭に「生成物」と明記）
  - `.codex/agents/*.toml`（`tools` に Edit/Write が無ければ `sandbox_mode = "read-only"`）
  - `.codex/config.toml` の MCP 部分（マーカーで囲んだ範囲だけ置き換え、他の設定は残す）
- スクリプト: `.llm-notes/sync.mjs`（Node 標準機能のみ・依存なし）
  - `node .llm-notes/sync.mjs` で生成、`--check` で差分があれば終了コード 1
- 秘密情報
  - `.claude/settings.json` の deny に `.env.keys` のサブディレクトリ分、`npx dotenvx` 経由などを追加
  - Read の deny は Bash の `cat .env` などを防げないため、PreToolUse フックで Bash コマンド中の `.env` / `.env.keys` 参照を止める（`.env.example` は許可）
  - Codex にはファイル単位の deny が無いので、指示（AGENTS.md）で守る（現状どおり）

## タスク
- [x] code-reviewer の正本を更新（Codex 版の観点に揃える: バグ・ロジック・回帰・可読性・保守性・テスト不足。編集禁止を明記）
- [x] `.llm-notes/sync.mjs` を作成（エージェント → toml、MCP → config.toml）
- [x] 生成して `.codex/` を更新、`--check` が通ることを確認
- [x] `.claude/settings.json` の deny を強化
- [x] `.claude/hooks/block-secrets.mjs` を作成し PreToolUse に登録、許可・拒否の両方を確認
- [x] MAIN.md に同期手順を追記
- [x] code-reviewer / security-reviewer でレビュー

## レビュー結果
code-reviewer / security-reviewer をそれぞれ 2 回実行。最終的に Critical・High はなし。

### 対応したもの
- フック: glob（`cat .env*` `.e*` `.*` `{.env,…}`）、大文字小文字（`.ENV`）、再帰検索（`grep -r` / `-d recurse`、`rg -u` / `--hidden`、`git grep --no-index`）、find/xargs 経由の読み出し、環境変数の一覧（`env` のオプション付き・絶対パス・`-u`、`export`、`export -p`、`declare -p/-x`、`set`、`/proc/*/environ`、`node -e process.env`、`dotenv/config`）、dotenvx のオプションを前に置く形
- フック: 異常時も拒否（fail-closed）。matcher に Write/Edit 系を追加。Grep の検索文字列は照合対象から外し誤検知を解消
- sync.mjs: 手置きの Codex 用 toml は削除しない、生成ブロックは常に末尾、BOM/CRLF・引用符・配列の frontmatter、制御文字・孤立サロゲート、name 検証、MCP の command 必須と env は `${NAME}` のみ（`env_vars`）、マーカー不整合の検出
- 検証: フックのテスト 97 件、sync のエッジケース 8 件すべて成功。`--check` で生成物が最新であることを確認

### 残るもの（対応しない・利用者判断）
- 正規表現では意図的な回避（`.e''nv`、変数展開、python の `os.environ` など）は止めきれない。偶発的な参照の防止が目的
- node が PATH にないとフックが動かずツールが実行される（終了コード 127）
- 根本対策は `.env.keys` をリポジトリ外（OS のキーチェーン等）に置くこと。Codex にはファイル単位の deny がないため、Codex に対してはこれが唯一の実効策
- Codex の MCP 設定 `env_vars` への対応は Codex 側で未確認（この環境に codex がない）
- 過剰な拒否（安全側）: `ls app/backend/.env`、Glob `**/.*`、`grep -r` 全般など。Bash のコマンド文字列に `.env` と書くだけで拒否されるので、ファイルへの追記は Edit/Write ツールで行う
