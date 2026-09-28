# 20260928 cradle-app MVP

乳児〜未就学児の成長記録アプリ。まずはシンプルな MVP を作る。

## 構成

ソースは `app/backend`（API）と `app/mobile-app`（Flutter）に置く。`docker-compose.yml` はルート。

| 層 | 技術 | ローカル | 検証/本番 |
|---|---|---|---|
| モバイル | Flutter 3.47 (stable) / Riverpod / go_router / dio / fl_chart | iOS Simulator / Android Emulator | 実機配布 (後続) |
| API | NestJS 12 + Prisma 7 | `npm run start:dev` (localhost:3000) | Vercel (Serverless) |
| DB | PostgreSQL 17 | Docker Compose | Supabase Postgres (pooler 経由) |
| 認証 | NestJS 独自 (email + password, scrypt, JWT access / rotating refresh) | 同一実装 | 同一実装 |

### 環境差異の吸収方針
- 違いは **環境変数だけ** にする（コードは同一）。`DATABASE_URL` / `DIRECT_URL` / `JWT_ACCESS_SECRET` / `CORS_ORIGINS` など
- `app/backend/.env.example` にキー一覧、ローカル用値は `docker-compose.yml` と揃える。本番値は Vercel の環境変数に設定（リポジトリに置かない）
- Prisma は `DATABASE_URL`（Supabase は transaction pooler :6543）と `DIRECT_URL`（マイグレーション用 :5432）を分離。ローカルは両方同じ Docker Postgres
- 起動時に環境変数をスキーマ検証（不足なら起動失敗）
- Flutter は `--dart-define=API_BASE_URL=...` で接続先を切替（`dev` / `prod` の2フレーバー相当）。Android エミュレータは `10.0.2.2`
- 認証を Supabase Auth ではなく Nest 側に持つ理由: ローカル（素の Postgres）と本番で同じ認証フローになり、環境差異が出ない

## MVP スコープ（フェーズ1）
- [x] 新規登録 / ログイン / ログアウト（JWT、トークンは secure storage）
- [x] こども登録・編集・一覧、選択中のこどもを切替
- [x] 記録: ミルク（時刻・ml）、睡眠（開始〜終了）、体重（g）、食事（時刻・内容メモ）
- [x] 記録一覧（日付ごと）、削除
- [x] グラフ: 体重推移、1日のミルク量合計
- [x] 認可: 自分が所属する家族のこども・記録にしかアクセスできない

データモデルは最初から「家族（Family）」単位にしておき、招待機能を後から足しても移行不要にする。

## 後続フェーズ（今回は作らない）
- 家族招待（招待コード/リンク）
- 画像添付（Supabase Storage / ローカルは MinIO 等の S3 互換）
- ミルクリマインダ（前回間隔からの次回予測 + ローカル通知）
- 食事傾向・次の食事提案

## データモデル
- User(id, email, passwordHash, name)
- Family(id, name) / FamilyMember(familyId, userId, role)
- Child(id, familyId, name, birthDate, sex?)
- Record(id, childId, createdById, type[MILK|SLEEP|WEIGHT|MEAL], startedAt, endedAt?, amountMl?, weightG?, note?)
- RefreshToken(id, userId, tokenHash, expiresAt, revokedAt?)

## API（/api/v1）
- POST auth/signup, auth/login, auth/refresh, auth/logout / GET me
- GET/POST children, PATCH/DELETE children/:id
- GET children/:id/records?from&to&type, POST children/:id/records, DELETE records/:id
- GET children/:id/stats/weight, children/:id/stats/milk-daily

## 作業項目
- [x] Flutter SDK インストール（未導入）
- [x] docker-compose.yml（Postgres 17、healthcheck、volume）
- [x] backend: Nest 雛形、Prisma スキーマ、マイグレーション、env 検証
- [x] backend: auth / children / records / stats モジュール + 認可ガード
- [x] backend: Vercel 用エントリ（`api/index.js` → `dist/serverless.js` + `vercel.json`）
- [x] backend: e2e テスト（ローカル Docker DB に対して）
- [x] mobile-app: Flutter 雛形、API クライアント、認証フロー
- [x] mobile-app: こども選択、記録入力、一覧、グラフ画面
- [x] mobile-app: `flutter analyze` / widget テスト
- [x] README にローカル起動手順・本番デプロイ手順
- [x] code-reviewer / security-reviewer 実行・指摘対応（3 ラウンド）

## レビュー

### 検証結果（最終）
- backend: `tsc` / `oxlint` OK、unit 3件・e2e 7件 pass（e2e は `cradle_test` DB、DB 名ガード付き）
- mobile-app: `flutter analyze` 0件、テスト 11件 pass
- 結合: ローカル API に対しアプリの通信層で signup→こども→記録→集計→トークン更新→ログアウト pass
- ビルド成果物: `node dist/main.js` と Vercel ハンドラ（`api/index.js`）で health / 401 を確認
- 同時リフレッシュ（プール上限 1〜2）: 200/401/401 で固まらない
- 未実施: iOS Simulator / Android Emulator での起動（Xcode・Android SDK 未導入）、Vercel/Supabase への実デプロイ

### 反映した指摘（抜粋）
- ログアウト中のトークン更新で再ログインされる競合 → Session.epoch + save の取り消し
- 日付をまたぐと古い日に記録される → selectedDay を「null=今日」に
- リフレッシュ時の例外でリクエストが止まる → catch-all
- tz にオフセット表記（+09:00）を許すと Postgres で符号逆転 → IANA 形式のみ
- scrypt の同時実行でメモリ枯渇 → 同時4・待ち32の制限
- JWT に iss/aud、本番/Vercel でプレースホルダ秘密鍵を拒否、trust proxy と DB プールは VERCEL で判定
- /health は DB に触れない、`.vercelignore` 追加、未来日時の記録を拒否、他家族 familyId は 404
- iOS Keychain は this_device、profile ビルドでも https 必須

### 受け入れたトレードオフ
- リフレッシュ応答が失われて再送した端末は再ログインが必要（再発行方式は盗用検知を弱めるため不採用。他端末は維持、猶予 10 秒）
- 同一トークンの同時使用は全失効（安全側）

### 後続で対応（未対応）
- [ ] レート制限の共有ストア化 / アカウント単位制限（Upstash Redis or Vercel WAF）。現状はインスタンス単位
- [ ] サインアップでのメール登録有無の露出（メール認証フロー導入時に解消）
- [ ] 期限切れ refresh_tokens の定期削除
- [ ] 環境ごとに JWT audience を分ける（現状は秘密鍵を環境ごとに分けて分離）
- [ ] iOS の NSAllowsLocalNetworking を Debug 構成のみに
- [ ] アプリを開いたまま日付をまたいだ時の自動更新・グラフ軸の日付ずれ
- [ ] api_contract_test のタイムゾーン固定（JST 以外の端末で深夜に不安定）
- [ ] Prisma CLI 経由の npm audit 指摘（deepmerge-ts / mysql2、実行時経路外）→ Prisma の更新待ち
