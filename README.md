# cradle-app（すくすく記録）


出産直後〜未就学児の成長記録アプリ（MVP）。

| ディレクトリ | 内容 |
|---|---|
| `app/mobile-app/` | Flutter（iOS / Android / Web） |
| `app/backend/` | NestJS API + Prisma。Web 版も同じ Vercel プロジェクトで配信 |
| `docker-compose.yml` | ローカル用 PostgreSQL |

## 環境の考え方

コードはローカル/検証/本番で同一で、**違いは環境変数だけ**です。

| | ローカル | 検証/本番 |
|---|---|---|
| DB | Docker の Postgres 17 | Supabase Postgres |
| API | `npm run start:dev` | Vercel |
| API の環境変数 | `app/backend/.env`（`.env.example` をコピー） | Vercel の Environment Variables |
| モバイルの接続先 | 既定値（`http://localhost:3000/api/v1`、Android エミュレータは `10.0.2.2`） | `--dart-define=API_BASE_URL=https://...` |
| Web の接続先 | 同一オリジンの `/api/v1`（開発サーバーのプロキシで API に転送） | 同一オリジンの `/api/v1`（Vercel） |

必要な環境変数は `app/backend/.env.example` を参照してください。起動時に検証され、不足・不正があると起動しません。

## ローカル起動

必要なもの: Node.js 22+、Docker、Flutter 3.47+、Xcode（iOS）/ Android Studio（Android）

```sh
# 1. DB
docker compose up -d --wait

# 2. API
cd app/backend
cp .env.example .env
npm install
npm run db:migrate        # マイグレーション適用
npm run start:dev         # http://localhost:3000/api/v1/health

# 3. アプリ
cd ../mobile-app
flutter pub get
flutter run
```

### Web 版

`app/mobile-app/web_dev_config.yaml` のプロキシで `/api/` を API に転送し、本番と同じ「Web と API が同一オリジン」の構成で動かします（CORS 設定は不要）。

```sh
cd app/backend && npm run start:dev          # API
cd app/mobile-app && flutter run -d chrome   # http://localhost:8080
```

ログイン維持に使う Cookie は `Secure` 付きのため、ローカルの http では Chrome / Firefox で確認してください（Safari は保存しません）。

本番と同じビルド・配信内容を確認したい場合は `cd app/backend && npm run build:web` で `public/` に出力されます（本番と揃えるため Flutter 3.47.5 が必要。バージョンが違うとエラーになります）。

## テスト

```sh
# API（e2e は Docker の cradle_test DB を使う。開発データには触れない）
cd app/backend && npm run test:e2e

# アプリ
cd app/mobile-app && flutter analyze && flutter test

# アプリの通信コード ↔ API の結合テスト（API をローカル起動した状態で）
API_CONTRACT_BASE_URL=http://localhost:3000/api/v1 flutter test test/api_contract_test.dart
```

## 検証/本番デプロイ

### Supabase
1. プロジェクトを作成し、Database の接続文字列を2つ控える
   - Transaction pooler（ポート 6543）→ `DATABASE_URL`
   - Direct / Session（ポート 5432）→ `DIRECT_URL`
2. マイグレーションを適用（手元または CI から。Vercel のビルドでは実行しない）
   ```sh
   cd app/backend
   DIRECT_URL='postgresql://...:5432/postgres' npm run db:migrate:deploy
   ```

### Vercel（API と Web を1プロジェクトでデプロイ）

```
https://<domain>/          → Flutter Web（app/backend/public/。ビルド時に生成）
https://<domain>/api/v1/*  → NestJS（Vercel Function）
```

1. Git リポジトリを連携してプロジェクトを作成
   - Root Directory: `app/backend`（設定は `app/backend/vercel.json`）
   - 「Include files outside the Root Directory in the Build Step」を有効のままにする（Web のビルドで `app/mobile-app` を使うため）
2. Environment Variables を設定
   - `NODE_ENV=production`
   - `DATABASE_URL` / `DIRECT_URL`（Supabase でスキーマを分ける場合は両方に `?schema=<name>` を付ける）
   - `JWT_ACCESS_SECRET`（`openssl rand -base64 48` などで生成。環境ごとに別の値）
   - 必要に応じて `JWT_ACCESS_TTL_SECONDS` / `REFRESH_TOKEN_TTL_DAYS`
   - `CORS_ORIGINS` は不要（Web と API が同一オリジンのため）
3. ビルドでは API のビルドに続けて `scripts/build-web.sh` が Flutter（バージョン固定）を取得し、Web をビルドします（数分かかります）
4. Preview デプロイは誰でもアクセスできるため、Deployment Protection を有効にし、Preview 用の環境変数（DB・秘密鍵）は本番と分ける
5. デプロイ後の確認
   - `https://<domain>/api/v1/health` が `{"status":"ok"}`（API の起動確認。DB には触れない）
   - `https://<domain>/` でログインでき、再読み込みしてもログイン状態が保たれること

#### Web のセキュリティ
- リフレッシュトークンは `__Secure-cradle_rt`（`HttpOnly; Secure; SameSite=Strict`）の Cookie（JS から読めない）。アクセストークンはメモリのみ
- Web クライアントは `X-Auth-Mode: cookie` ヘッダーを付け、サーバーはこのときだけ Cookie を使う（CSRF 対策。CORS で credentials を許可しないことが前提）
- 複数タブのトークン更新は Web Locks で直列化（同じ Cookie の同時使用は盗用とみなされ全端末ログアウトになるため）
- CSP などのセキュリティヘッダーは `vercel.json` で付与

### モバイルアプリ
```sh
flutter build ipa --dart-define=API_BASE_URL=https://<domain>/api/v1
flutter build appbundle --dart-define=API_BASE_URL=https://<domain>/api/v1
```
リリースビルドは `API_BASE_URL` 未指定または `http://` だと起動時にエラーになります。

## API（`/api/v1`）

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/auth/signup` `/auth/login` `/auth/refresh` `/auth/logout` | 認証 |
| GET | `/me` | ログイン中のユーザー |
| GET / POST | `/children` | こども一覧 / 登録 |
| PATCH / DELETE | `/children/:id` | 編集 / 削除 |
| GET / POST | `/children/:id/records` | 記録一覧（`from` `to` `type`）/ 登録 |
| DELETE | `/records/:id` | 記録削除 |
| GET | `/children/:id/stats/weight` | 体重の推移 |
| GET | `/children/:id/stats/milk-daily` | 1日ごとのミルク量（`from` `to` `tz`） |
| GET | `/health` | ヘルスチェック |
