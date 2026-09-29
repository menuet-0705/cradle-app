# Lessons

## 2026-09-28: ソースコードの配置先
- 指摘: `backend/` `mobile-app/` をリポジトリ直下に作ったが、正しくは `app/backend` `app/mobile-app`
- 原因: 依頼文の「backend フォルダに作成」を直下と解釈し、配置先の親ディレクトリを確認しなかった
- ルール: アプリのソースは `app/` 配下に置く。新しいプロジェクト・フォルダを作る前に、配置先が明示されていなければ計画書（`.steering`）に置き場所を書いて確認を取る

## 2026-09-28: 本番（Vercel）でだけ起きる ERR_REQUIRE_ESM
- 指摘: Web の新規登録で `ERR_REQUIRE_ESM`（@nestjs/throttler が ESM 専用の @nestjs/common を require）
- 原因: 手元の Node 22 は require(esm) に対応しているため、ローカルの検証をすべて通過していた。Vercel の実行環境との差を検証していなかった
- ルール: 「本番と同じ条件」で確認できない差分は、差を再現する形で検証する。Node の ESM/CJS については `node --no-experimental-require-module` で読み込み確認する（`npm run build` に組み込み済み）。依存を追加したら CommonJS かどうかと、ESM 専用パッケージを require していないかを確認する

## 2026-09-29: 外部サービスの使い方（Resend）
- 指摘: 「Resend で送る」なら `RESEND_API_KEY` / `EMAIL_FROM` で公式ライブラリ（`import { Resend } from "resend"`）を使うのでは？（実装は SMTP 経由・`SMTP_URL` / `MAIL_FROM` だった）
- 原因: 環境差異をなくす都合（ローカルの Mailpit と同じ SMTP）を優先し、利用者が想定する「そのサービスの標準的な使い方・変数名」とずれた方式を、確認せずに選んだ
- ルール: 利用者が外部サービスを名指ししたら、公式 SDK と一般的な環境変数名を既定にする。別の方式（SMTP 互換など）を選ぶ理由があるときは、計画書に書いて選択肢として確認を取る。環境差異の吸収は「送信手段の差し替え」で実現する（コードの抽象化で吸収し、サービスの使い方は曲げない）

## 2026-09-29: 本番（Vercel）でだけ起きる ERR_MODULE_NOT_FOUND（ファイル追跡の取りこぼし）
- 指摘: デプロイ後に `ERR_MODULE_NOT_FOUND`（`.../node_modules/openai/lib/responses/ResponseInputItems.js`、@langchain/openai が import）で API 全体が起動しない
- 原因: Vercel は @vercel/nft で依存をたどったファイルだけを関数に入れる。@vercel/node が使う nft 1.10.0 は openai の exports のパターン（`./lib/*.js` と `./lib/*`）を解決し損ね、手元にはあるファイルを落としていた。ビルド時の互換チェックは手元の node_modules で起動していたので、この差を検出できなかった
- ルール: 「手元で動く」ではなく「Vercel に載るファイルだけで動く」ことを確認する。`npm run build` のチェック（scripts/check-vercel-bundle.mjs）は、Vercel と同じ版の nft で集めたファイルと includeFiles だけを一時ディレクトリにコピーして起動する。依存を追加したら必ず `npm run build` を通し、@vercel/nft の版は Vercel のビルドログに出る @vercel/node の版に合わせて更新する。確認できるのは起動までに読み込まれるモジュールだけなので、遅延読み込みされる依存は別途デプロイ後に確認する
