# 20260928 Web 版を API と同じ Vercel プロジェクトで公開する（方法A）

Flutter Web を正式公開する。`app/backend` の Vercel プロジェクトに Web の静的ファイルを同居させ、1回のデプロイで両方を更新する。

```
https://<domain>/          → Flutter Web（静的ファイル、public/）
https://<domain>/api/v1/*  → NestJS（Vercel Function）
```

## 方針

### 1. Web の認証（正式公開のためのセキュリティ対応）
ブラウザではトークンを JS から読める場所（localStorage 等）に置かない。

| | モバイル（現状維持） | Web（新規） |
|---|---|---|
| アクセストークン | Keychain / Keystore | メモリのみ（リロードで消える） |
| リフレッシュトークン | Keychain / Keystore、JSON で受け渡し | **HttpOnly Cookie**（JS から読めない） |
| リロード時 | 保存済みトークンを読む | 起動時に Cookie で `/auth/refresh` → 復元 |

- Cookie: `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=<refresh TTL>`
  - `Secure` は常に付ける（Chrome/Firefox/Safari は localhost を安全なオリジンとして扱う）→ 環境で分岐しない
- Web クライアントは `X-Auth-Mode: cookie` ヘッダーを付ける。サーバーはこのヘッダーがあるときだけ Cookie を発行・参照し、JSON 本文にリフレッシュトークンを含めない
- CSRF 対策: SameSite=Strict ＋ カスタムヘッダー必須（別オリジンからはプリフライトで拒否される。本番は CORS 許可なし）
- モバイルの挙動・API 互換は変えない

### 2. 同一オリジン化（ローカルも本番と同じ構成に）
- 本番: Web と API が同じドメイン → CORS 不要（`CORS_ORIGINS` は空のまま）
- ローカル: Flutter の開発サーバーのプロキシ（`web_dev_config.yaml`）で `/api/` を `localhost:3000` に転送 → ローカルも同一オリジン。起動時の `CORS_ORIGINS` 指定も不要になる
- Web の接続先は既定で「自分のオリジン + `/api/v1`」。`--dart-define` 不要

### 3. Vercel の構成（`app/backend/vercel.json`）
- ビルド: `npm run build`（API）→ `npm run build:web`（Flutter Web を `public/` に出力）
- Flutter はビルド環境にないため、`scripts/build-web.sh` がバージョン固定（3.47.5）で取得してビルド
  - ローカルではインストール済みの flutter を使う（バージョン不一致は警告）
- ルーティング: `/api/*` → Function、ファイルがあればそのまま配信、それ以外 → `index.html`（パス形式の URL に対応）
- `--no-web-resources-cdn`: CanvasKit を自前ドメインから配信（外部 CDN に依存しない）
- セキュリティヘッダー（Web 側）: CSP、`X-Frame-Options: DENY`、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`
  - CSP は Flutter の動作に必要な最小限（`wasm-unsafe-eval`、フォント取得のための `fonts.gstatic.com` など）。実ブラウザで違反が出ないことを確認して確定
- URL を `/#/login` 形式から `/login` 形式に変更（`usePathUrlStrategy`）

### 4. 変更しないもの
- DB・環境変数の考え方（違いは環境変数だけ）
- モバイルアプリの認証フロー

## 作業項目
- [x] backend: Cookie モードの認証（signup / login / refresh / logout）＋ e2e テスト（属性・ヘッダー必須・ローテーション・ログアウトで削除）
- [x] mobile-app: Web ではトークンを保存しない Session、起動時の Cookie 復元、`X-Auth-Mode` 付与、接続先の既定値
- [x] mobile-app: `usePathUrlStrategy`、`web_dev_config.yaml`（ローカルのプロキシ）、index.html のタイトル等
- [x] backend: `scripts/build-web.sh`、`build:web`、`vercel.json`（ルーティング・ヘッダー）、`.gitignore`（`public/` はビルド成果物）
- [x] 検証: リリースビルドを Vercel と同じルーティング・ヘッダーでローカル配信し、ヘッドレス Chrome で画面表示と CSP 違反なしを確認
- [x] 検証: ローカルで Web（プロキシ経由）→ 登録・リロードでログイン維持・ログアウト
- [x] README 更新
- [x] code-reviewer / security-reviewer（3 ラウンド、最終的に Critical/High/Medium なし）

## 確認できないこと（デプロイ時に確認）
- Vercel のビルド環境での Flutter 取得・ビルド（ローカルでは同じスクリプトを実行して確認）
- 本番ドメインでの Cookie / CSP の最終確認

## レビュー

### 検証結果
- backend: unit 4件・e2e 10件 pass（`?schema=cradle-app` でも 10件 pass）
- mobile-app: analyze 0件、テスト 12件 pass、結合テスト pass
- Vercel 相当のローカル配信（vercel.json のルーティング・ヘッダーを再現）＋ ヘッドレス Chrome（CDP）で:
  - CSP 違反・例外なし、日本語フォント表示 OK
  - ログイン → JS から Cookie / localStorage が見えない → 再読み込みで Cookie から復元 → ログアウト → 再読み込みでログイン画面
  - 3 タブ同時オープン: 更新は直列化され、全端末ログアウト（revoke-all）は発生しない
- Flutter なしの環境（Vercel 相当）で build-web.sh: 取得・コミット照合・ビルド成功
- 開発サーバーのプロキシ（web_dev_config.yaml）経由で API に到達、Cookie 属性も本番と同じ

### 実装中に見つけた問題
- **DB スキーマ指定が実行時に効いていなかった**: `.env` が Supabase（`?schema=cradle-app`）に変わっており、pg ドライバアダプタは `?schema=` を解釈しないため `public` を参照していた → アダプタに schema を渡し、生 SQL もスキーマ修飾。DIRECT_URL と DATABASE_URL のスキーマ不一致は prisma.config.ts で検出
- 上記の調査中、検証用サーバーが `.env` 経由で Supabase に接続してログインクエリを1回実行（失敗・書き込みなし）→ 以後の検証は接続先を環境変数でローカル DB に固定
- e2e の準備処理が DATABASE_URL を `.env`（Supabase）のまま使っていた → テスト DB に固定

### 反映した指摘
- (High) 複数タブの同時更新で全端末ログアウト → Web Locks で直列化
- 更新失敗時に Cookie を消さない / refresh のレート制限を 60/分に分離 / 復元処理は全例外を捕捉・5 秒タイムアウト
- Cookie 名 `__Secure-` 接頭辞、同名 Cookie 重複は拒否、認証応答に `Cache-Control: no-store`、HSTS
- CORS の allowedHeaders を明示、Web の API は同一オリジン必須、モバイルで refreshToken 欠落は FormatException
- build-web.sh: コミット SHA 照合、バージョン不一致はエラー、`--enforce-lockfile`、キャッシュを node_modules/.cache に
- `*.tsbuildinfo` を追跡対象から除外
- (Medium) ログアウトと他タブの更新が重なるとログアウトが取り消される → ログアウト・ログイン・登録もロック内で実行
- 起動時の復元は通信を打ち切らず、待ち時間だけ 5 秒で切り上げ（打ち切ると失効済み Cookie が残るため）
- build-web.sh: Flutter の取得先をスクリプト専用パスに固定、キャッシュの改変を検出したら再取得
- prisma.config.ts: URL 解析エラーに接続文字列を含めない / HSTS は includeSubDomains なし

### 受け入れたこと
- CSP の `style-src 'unsafe-inline'`（Flutter エンジンが必要。外すと違反を確認）。script-src は 'self' のみ
- 初回訪問時の `401 /auth/refresh`（Cookie がないため。コンソールにエラー表示が出る）
- Flutter SDK（約 1.1GB）は Vercel のビルドキャッシュ上限を超える可能性があり、毎回取得になる場合がある（ビルド +1〜2 分）

### 後続で検討
- [ ] 初回訪問時の 401 をコンソールに出さない工夫（ログイン有無を示す非 HttpOnly の目印 Cookie など）
- [ ] 独自ドメインを付ける場合の HSTS（includeSubDomains / preload）の方針

### 未確認（デプロイ時に確認）
- Vercel 上での実ビルド・本番ドメインでの Cookie / CSP

