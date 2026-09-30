# cradle-app（すくすく記録）

出産直後〜未就学児の成長記録アプリ（MVP）。

| ディレクトリ | 内容 |
|---|---|
| `app/mobile-app/` | Flutter（iOS / Android / Web） |
| `app/backend/` | NestJS API + Prisma。Web 版も同じ Vercel プロジェクトで配信 |
| `docker-compose.yml` | ローカル用 PostgreSQL・Mailpit（メール確認用） |

## 環境の考え方

コードはローカル/検証/本番で同一で、**違いは環境変数だけ**です。

| | ローカル | 検証/本番 |
|---|---|---|
| DB | Docker の Postgres 17 | Supabase Postgres |
| メール（家族招待） | Docker の Mailpit に SMTP で送る（`SMTP_URL`。外部に届かない。http://localhost:8025 で確認） | Resend の API（`RESEND_API_KEY`、公式 SDK） |
| API | `npm run start:dev` | Vercel |
| API の環境変数 | `app/backend/.env`（`.env.example` をコピー） | Vercel の Environment Variables |
| モバイルの接続先 | 既定値（`http://localhost:3000/api/v1`、Android エミュレータは `10.0.2.2`） | `--dart-define=API_BASE_URL=https://...` |
| Web の接続先 | 同一オリジンの `/api/v1`（開発サーバーのプロキシで API に転送） | 同一オリジンの `/api/v1`（Vercel） |

必要な環境変数は `app/backend/.env.example` を参照してください。起動時に検証され、不足・不正があると起動しません。

## ローカル起動

必要なもの: Node.js 22+、Docker、Flutter 3.47+、Xcode（iOS）/ Android Studio（Android）

```sh
# 1. DB・メール確認用サーバー（Mailpit: http://localhost:8025）
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

### ダミーデータ

画面や AI 機能の確認用に、既存のこどもへ過去 30 日分の記録（ミルク・睡眠・体重・食事）を入れます。こどもはアプリで登録しておきます。

```sh
cd app/backend
npm run db:seed:dev                 # こどもの一覧（id と直近 30 日の件数）
npm run db:seed:dev -- <childId>    # ダミーを入れる
```

- 接続先は `SEED_DATABASE_URL`（未指定ならローカルの Docker の DB）。`.env` は読みません
- 量や回数は月齢に合わせます（離乳食は生後 5 か月から、3 歳からはミルク・昼寝なし）。食事は「甘い野菜・炭水化物が多く、赤身の肉・魚が少ない」傾向にしてあります
- 何度実行しても重複しません（同じ日・同じ区分の食事など、すでにある記録は入れない）。生まれる前と未来の時刻は入れません

検証環境（Supabase）に入れるときは `--remote` を付けます。**本番には使わないでください。**

```sh
export SEED_DATABASE_URL='postgresql://postgres.<project-ref>:...@...pooler.supabase.com:5432/postgres?schema=<name>'
npm run db:seed:dev -- --remote [<childId>]
```

- 接続後に `接続先: postgres.<project-ref>@...` を表示して y/N を聞くので、**project-ref が検証環境のものか確かめてから** `y` を押します（Supabase の pooler は本番と検証でホスト名が同じで、ここでしか見分けられません）。端末以外（パイプ・CI）からは実行できません
- Session pooler / Direct（ポート 5432）を使います。Transaction pooler（6543）は schema の指定が効かないので拒否します
- 常に SSL で接続します。`SEED_DATABASE_CA` に CA 証明書（Supabase の Database 設定からダウンロード）のパスを渡すと、サーバーの証明書も検証します
- 接続文字列はパスワードを含むので、チャットやコマンドの記録に残さないようにしてください

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

### Resend（招待メールの送信）
1. https://resend.com でアカウントを作成
2. Domains で送信元ドメインを追加し、表示される DNS レコード（SPF / DKIM）を登録して認証する
   - 認証前は自分のアドレス宛てにしか送れません
3. API Keys で「Sending access」のキーを作成し、Vercel の `RESEND_API_KEY` に設定する（リポジトリには置かない）

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
   - 家族招待のメール（3 つとも設定したときだけ有効。未設定なら招待の送信は 503）
     - `RESEND_API_KEY=re_...`（Resend の API キー。設定すると Resend の API で送る。`SMTP_URL` は不要）
     - `EMAIL_FROM=すくすく記録 <no-reply@<認証済みドメイン>>`
     - 以前の設定（`SMTP_URL` / `MAIL_FROM`）が残っていれば削除してよい（残っていても `RESEND_API_KEY` と `EMAIL_FROM` が優先される）
     - `NODE_ENV=production` を必ず設定する（Resend の SDK は production 以外では送信エラーの内容〈宛先を含むことがある〉をログに出すため）
     - `APP_URL=https://<domain>`（招待リンクの起点。https 必須）
   - AI（食事の提案・習慣レポート。選んだプロバイダの API キーがあるときだけ有効。未設定なら AI 機能は 503）
     - 既定は Gemini: `GOOGLE_API_KEY`（Google AI Studio で発行）だけ設定すればよい（モデルは `gemini-3.7-flash`）
     - 切り替え: `LLM_PROVIDER=openai` + `OPENAI_API_KEY`、または `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`
     - モデルを変える場合は `LLM_MODEL`（例: `gemini-3.5-flash-lite`）。コードの変更は不要
     - `LLM_PROVIDER` / `LLM_MODEL` を設定したのに対応するキーがない場合は起動エラー
   - 習慣レポートの定期実行: `CRON_SECRET`（32 文字以上。`openssl rand -base64 48` などで生成）
     - Vercel Cron が毎週金曜 17:00〜23:00 JST に毎時 `/api/v1/internal/cron/weekly-reports` を呼ぶ（`vercel.json` の `crons`）。1 回の実行では生成か通知のどちらかだけを行う（制限時間に収めるため）。作り切れなかった分は次の回で作り、全員分できた次の回（または 23:00 の最後の回）にメールで通知する
     - Vercel は `Authorization: Bearer <CRON_SECRET>` を付けて呼ぶ。未設定なら Cron のエンドポイントは 404（無効）
     - Hobby プランでは実行時刻が指定の 1 時間内でずれることがある
     - 処理量の目安: 1 回あたり十数〜数十人分（LLM の応答時間しだい）。最後の回で作り切れなかった場合は警告ログ（`Weekly reports incomplete on the final run`）が出るので、Cron の回数を増やす（Pro）・並列数を見直す
   - AI と Cron の API（`/api/v1/children/:id/ai/*`・`/api/v1/internal/*`）は、LLM の応答を待つため別の関数（`api/ai.js`、制限時間 60 秒）で動く。他の API は `api/index.js`（10 秒）のまま
   - AI のプライバシー
     - LLM には月齢・性別・記録の内容を送る（こどもの名前・利用者の名前・メールは送らない。メモ中のこどもの名前も伏せ字にするが、愛称などは防げない）
     - 本番では、送った内容を学習に使わない有料枠・契約のキーを使う（Gemini API の無料枠は、送った内容が品質改善に使われることがある）
     - `LANGSMITH_TRACING` / `LANGCHAIN_TRACING_V2` は本番で設定しない（設定するとプロンプト全文が LangSmith に送られる）
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

### 習慣レポートを手元で作る
Vercel Cron はローカルでは動かないので、API を起動した状態で手動で呼びます（`.env` に `CRON_SECRET` と AI のキーを設定しておく）。
直近の金曜 17:00 JST までの 7 日間のレポートが作られます（作成済みのこどもはスキップ）。1 回の呼び出しでは生成か通知のどちらかだけを行うので、1 回目で生成し、作るものがなくなった次の呼び出しで通知メールが送られます（Mailpit: http://localhost:8025 で確認）。
```sh
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/v1/internal/cron/weekly-reports
```

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
| GET / POST | `/children` | こども一覧 / 登録（1 家族 10 人まで） |
| PATCH / DELETE | `/children/:id` | 編集 / 削除 |
| GET / POST | `/children/:id/records` | 記録一覧（`from` `to` `type`）/ 登録 |
| DELETE | `/records/:id` | 記録削除 |
| GET | `/children/:id/stats/weight` | 体重の推移 |
| GET | `/children/:id/stats/milk-daily` | 1日ごとのミルク量（`from` `to` `tz`） |
| GET | `/families` | 所属する家族とメンバー |
| POST / GET | `/families/:id/invites` | 招待メールの送信（`email`）/ 招待中の一覧 |
| DELETE | `/families/:id/invites/:inviteId` | 招待の取り消し |
| DELETE | `/families/:id/members/:userId` | メンバーを外す（管理者）/ 自分なら退出 |
| POST | `/invites/preview` `/invites/accept` | 招待コードの確認 / 参加（`code`。招待されたアドレスのユーザーのみ） |
| GET | `/children/:id/ai/meal-suggestions/latest` | 直近の食事の提案と、今日の残り回数 |
| POST | `/children/:id/ai/meal-suggestions` | 食事の提案を生成（こども 1 人あたり 1 日 3 回まで。失敗も含めた試行はこども 1 人 6 回・利用者 1 人 20 回〈作成 1 日以内のアカウントは 6 回〉まで） |
| GET | `/children/:id/ai/weekly-reports` | 習慣レポートの一覧（`limit`） |
| GET / PATCH | `/me/notification-settings` | レポート完成メールの受け取り設定（`weeklyReportEmail`） |
| GET | `/internal/cron/weekly-reports` | 習慣レポートの作成と通知（Vercel Cron 専用。`CRON_SECRET`） |
| GET | `/health` | ヘルスチェック |
