# cradle-app（すくすく記録）

出産直後〜未就学児の成長記録アプリ（MVP）。

| ディレクトリ | 内容 |
|---|---|
| `app/mobile-app/` | Flutter（iOS / Android） |
| `app/backend/` | NestJS API（Vercel にデプロイ） + Prisma |
| `docker-compose.yml` | ローカル用 PostgreSQL |

## 環境の考え方

コードはローカル/検証/本番で同一で、**違いは環境変数だけ**です。

| | ローカル | 検証/本番 |
|---|---|---|
| DB | Docker の Postgres 17 | Supabase Postgres |
| API | `npm run start:dev` | Vercel |
| API の環境変数 | `app/backend/.env`（`.env.example` をコピー） | Vercel の Environment Variables |
| アプリの接続先 | 既定値（`http://localhost:3000/api/v1`、Android エミュレータは `10.0.2.2`） | `--dart-define=API_BASE_URL=https://...` |

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

### Vercel
1. Root Directory を `app/backend` にしてプロジェクトを作成（設定は `app/backend/vercel.json`）
2. Environment Variables を設定
   - `NODE_ENV=production`
   - `DATABASE_URL` / `DIRECT_URL`
   - `JWT_ACCESS_SECRET`（`openssl rand -base64 48` などで生成。環境ごとに別の値）
   - 必要に応じて `JWT_ACCESS_TTL_SECONDS` / `REFRESH_TOKEN_TTL_DAYS` / `CORS_ORIGINS`
3. デプロイ後 `https://<domain>/api/v1/health` が `{"status":"ok"}` を返すこと（API の起動確認。DB には触れない）と、アプリからログインできることを確認

### アプリ
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
