# 20260929 AI 機能（食事の提案・習慣レポート）

こどもの記録をもとに、LLM で次の 2 つを作る。

1. **食事の提案**: 過去 1 か月の食事記録から、好きそうな食べ物・不足気味の栄養を補う「次の食事」を提案する（利用者が画面で依頼したときに生成）
2. **習慣レポート**: 毎週金曜 17:00 JST に、こどもごとに 1 週間をふりかえるレポートを自動で作る（よかった点・気になる点・傾向）

## 前提（既存の構造）
- 食事は `Record.type = MEAL`。内容は自由記述の `note`（必須・500 文字以内）だけ。量・栄養素の項目はない
  → 「好きそう」「不足気味の栄養」は LLM が `note` の文章から推定する
- ミルク（`amountMl`）・睡眠（`startedAt`〜`endedAt`）・体重（`weightG`）は数値がある → レポートの集計はコードで行い、LLM には集計結果を渡す
- API は NestJS（ESM）。本番は Vercel Function 1 本（`api/index.js`、`maxDuration: 10`）
- Vercel は require(esm) 非対応（lessons 参照）。追加する依存は CJS/ESM 両対応かを確認し、`npm run build` の互換チェックを通す

## 技術選定

### ライブラリ（2026-09-29 時点の最新）
| パッケージ | 版 | 用途 |
|---|---|---|
| `langchain` | 1.5.14 | 共通（プロンプト等） |
| `@langchain/core` | 1.2.13 | メッセージ・構造化出力 |
| `@langchain/langgraph` | 1.4.18 | 処理の流れ（グラフ）の定義 |
| `@langchain/google-genai` | 2.3.2 | Gemini（既定） |
| `@langchain/openai` | 1.6.0 | ChatGPT に切り替える場合 |
| `@langchain/anthropic` | 1.5.11 | Claude に切り替える場合 |

- いずれも `exports` に `require`（.cjs）と `import` の両方があり、Vercel の制約に抵触しない見込み（ビルド時の互換チェックで確認）
- zod は既存の v4 をそのまま使う（LangGraph / LangChain とも zod v4 対応）

### LLM の切り替え（環境変数だけで切り替え）
| 変数 | 例 | 説明 |
|---|---|---|
| `LLM_PROVIDER` | `google` / `openai` / `anthropic` | 既定 `google` |
| `LLM_MODEL` | `gemini-3.8-flash` | 省略時はプロバイダごとの既定（google: `gemini-3.8-flash`） |
| `GOOGLE_API_KEY` | | Gemini（`@langchain/google-genai` の標準の変数名） |
| `OPENAI_API_KEY` | | ChatGPT |
| `ANTHROPIC_API_KEY` | | Claude |

- 各 SDK の公式パッケージ・標準の変数名を使う（lessons 2026-09-29）
- `src/ai/chat-model.factory.ts` で `LLM_PROVIDER` を見て `ChatGoogleGenerativeAI` / `ChatOpenAI` / `ChatAnthropic` を生成し、`BaseChatModel` として DI で注入する。機能側のコードはプロバイダを意識しない
  - `langchain` の `initChatModel`（動的 import）は、Vercel のファイル追跡で取りこぼす恐れがあるため使わず、静的 import の switch にする
- 選んだプロバイダのキーが未設定なら AI 機能は無効（API は 503）。メールと同じく「一部だけ設定」は起動エラー
- テストは LangChain の Fake モデルを注入し、外部 API は呼ばない

### LangGraph での処理の流れ
**食事の提案**（`mealSuggestionGraph`）
```
START → analyzeMeals（LLM: 1 か月分の食事メモから 好み・よく食べる食材・不足しがちな栄養 を構造化出力）
      → suggestMeals（LLM: 月齢・分析結果から「次の食事」を 3 案、理由・補える栄養・注意点つきで構造化出力）
      → END
```
**習慣レポート**（`weeklyReportGraph`）
```
START → summarize（コード: ミルク量/回数・睡眠時間・食事回数・体重の変化を日別に集計。LLM は使わない）
      → writeReport（LLM: 集計＋食事メモから よかった点・気になる点・傾向 を構造化出力）
      → END
```
- DB の読み書きはサービス側で行い、グラフには必要なデータだけを渡す（グラフ単体でテストできる）
- 出力は zod スキーマで構造化（`withStructuredOutput`）。画面では箇条書きで表示する

## 仕様

### 食事の提案
- 画面: こども選択中のホームに「AIによる分析」タブを追加 →「食事の提案」カードの「提案してもらう」ボタン
- 入力: 過去 30 日の MEAL 記録（最大 200 件、新しい順）＋ こどもの月齢
  - 食事記録が 0 件のときは LLM を呼ばず「食事を記録すると提案できます」を返す
- 出力: 好みの傾向（1〜3 行）、不足気味の栄養（あれば）、提案 3 件（料理名・理由・補える栄養・月齢に応じた注意点）
- 生成した提案は DB に保存し、画面を開くと直近の提案を表示（毎回生成しない）
- 上限（JST の日付で区切り、DB の件数で判定。IP 単位のメモリ制限はサーバーレスでは効きにくいため）
  - こども 1 人あたり成功 3 回・試行（失敗を含む）6 回
  - 利用者 1 人あたり試行 20 回（作成 1 日以内のアカウントは 6 回）。こどもの削除で消えない `ai_usages` で数える
  - 全体で試行 1000 回（費用の最後の安全装置。到達時は 503 `AI_BUSY` と警告ログ）
  - 1 家族のこどもは 10 人まで（家族ごとの advisory lock で直列化）
  - 生成前に行を作ってから数える（同時に依頼されても超えない）。強制終了で残った生成中の行は 2 分後に成功回数から外す

### 習慣レポート
- 対象期間: 生成時刻から遡った 7 日間（前週金曜 17:00 〜 今週金曜 17:00 JST。すき間・重複なし）
- 対象: 期間内に記録が 1 件以上あるこどもだけ（記録なしは LLM を呼ばない）
- 出力: よかった点・気になる点・傾向（各 1〜4 項目）＋ 集計値（画面のサマリー表示用）
- 保存: `(childId, periodEnd)` で一意。同じ週に 2 回実行しても重複しない（再実行・リトライが安全）
- 画面: 「AIによる分析」タブの「習慣レポート」に最新のレポートと過去の一覧

### レポート完成のメール通知
- 家族のメンバー全員に「今週のレポートができました」をメールで送る（既存の Resend / Mailpit の送信手段を使う）
  - 本文: こどもの名前（エスケープ済み）と、アプリへのリンク（`APP_URL`）。レポートの中身はメールに載せない（転送・誤送信時の露出を抑える）
  - 1 人あたり 1 通にまとめる（複数のこどもがいても 1 通）
- 配信停止: 利用者ごとの設定 `User.weeklyReportEmail`（既定オン）。「AIによる分析」タブにスイッチを置き、メールにも設定変更の案内を書く
- 二重送信の防止: `WeeklyReport.notifiedAt` を「未通知 → 通知済み」に 1 回だけ更新できたものだけ送る（Cron が重なっても同じレポートを 2 回通知しない。送信失敗時は再送しない＝最大 1 回）
- メール未設定の環境では通知だけスキップ（レポートは作る）

### 自動実行（金曜 17:00 JST〜）
- **Vercel Cron Jobs** で `GET /api/v1/internal/cron/weekly-reports` を金曜 17:00〜23:00 JST に毎時呼ぶ（`vercel.json` に 7 件、`0 8〜14 * * 5` UTC）
  - 認証: Vercel が付ける `Authorization: Bearer <CRON_SECRET>` を sha256 + 定数時間比較で検証。`CRON_SECRET` 未設定なら 404（エンドポイントを無効化）
- 1 回の実行では「生成」か「通知」のどちらかだけを行う（起動時間・メール送信のタイムアウトを含めて 60 秒に収めるため）
  - 生成: 未作成のこども（ランダムな順）を並列 6 本で、LLM 20 秒 + DB の余裕が開始から 40 秒以内に収まるときだけ始める
  - 通知: 作るものが残っていない回（全員分できた次の回）と最後の回（金曜 23:00〜翌 17:00）に、未通知の分を送る。送り始めは 42 秒まで
  - 最後の回で作り切れなかった場合は警告ログ（処理量の上限。目安は 1 回十数〜数十人、週 6 回の生成）
- AI と Cron の API は別の Vercel 関数 `api/ai.js`（`maxDuration` 60）に rewrites で振り分ける。他の API は `api/index.js`（10 秒）のまま
- ローカルでは Vercel Cron が動かないので、`curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/v1/internal/cron/weekly-reports` で手動実行する（README に記載）

### プライバシー・安全性
- LLM に送るのは **月齢・性別・記録内容のみ**。こどもの名前・家族名・利用者名・メールは送らない
- 記録メモは「データ」として区切って渡し、メモ内の指示に従わないようシステムプロンプトで明示（プロンプトインジェクション対策）
- 出力は医療的な診断をしない旨を指示し、画面に「AI による参考情報です。体調の心配は医師・保健師に相談してください」を常に表示
- 月齢に不適切な食材（1 歳未満のはちみつ等）を提案しないよう指示に含める。アレルギーは記録にないので「初めての食材は少量から」を注意点として出させる
- LLM のエラー・タイムアウトは 502 で返し、内容（キー等）はログにもレスポンスにも出さない
- アクセス制御は既存の `ChildrenService.assertAccess`（所属家族のこどもでなければ 404）を使う

## データモデル
```prisma
model MealSuggestion {
  id          String    @id @default(uuid()) @db.Uuid
  childId     String    @db.Uuid
  createdById String?   @db.Uuid
  content     Json?     // 構造化出力（好み・不足栄養・提案 3 件）。null は生成中/失敗
  model       String    // 生成に使ったモデル名（例: google:gemini-3.8-flash。応答には含めない）
  failedAt    DateTime? // 生成に失敗（試行として数える）
  createdAt   DateTime  @default(now())
  @@index([childId, createdAt])
}

// 利用者単位・全体の上限を数える。こどもの削除で消えない（userId は SetNull）
model AiUsage {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String?  @db.Uuid
  createdAt DateTime @default(now())
  @@index([userId, createdAt])
  @@index([createdAt])
}

model WeeklyReport {
  id          String   @id @default(uuid()) @db.Uuid
  childId     String   @db.Uuid
  periodStart DateTime
  periodEnd   DateTime
  summary     Json     // 集計値
  content     Json     // よかった点・気になる点・傾向
  model       String
  notifiedAt  DateTime? // メール通知済み（二重送信防止）
  createdAt   DateTime @default(now())
  @@unique([childId, periodEnd])
  @@index([childId, periodEnd])
}
```
（MealSuggestion / WeeklyReport は Child 削除時に Cascade。時刻の列はすべて timestamptz）

`User` に `weeklyReportEmail Boolean @default(true)` を追加

## API（/api/v1）
| メソッド | パス | 説明 |
|---|---|---|
| POST | `/children/:childId/ai/meal-suggestions` | 提案を生成して保存・返す（上限超過は 429 `DAILY_LIMIT`、全体の上限は 503 `AI_BUSY`） |
| GET | `/children/:childId/ai/meal-suggestions/latest` | 直近の提案（なければ null） |
| GET | `/children/:childId/ai/weekly-reports?limit=` | レポート一覧（新しい順、既定 10 件） |
| GET | `/me/notification-settings` | 通知設定（`weeklyReportEmail`） |
| PATCH | `/me/notification-settings` | 通知設定の変更 |
| GET | `/internal/cron/weekly-reports` | Cron 専用（`CRON_SECRET`）。JWT 認証の対象外。レポート作成 → メール通知 |

## 実装ステップ
### バックエンド
- [x] 依存追加（langchain / @langchain/core / @langchain/langgraph / google-genai / openai / anthropic）
- [x] `env.ts`: `LLM_PROVIDER` / `LLM_MODEL` / 各 API キー / `CRON_SECRET` の検証と `config.ai` の組み立て ＋ `env.spec.ts`
- [x] `src/ai/ai-model.ts` ＋ `AiModule`（`AI_MODEL` トークンで注入。未設定なら 503 を返す実装）
- [x] `src/ai/meal-suggestion.graph.ts`（LangGraph）＋ 単体テスト（Fake モデル）
- [x] `src/ai/weekly-report.graph.ts`（集計ノード＋LLM ノード）＋ 集計の単体テスト
- [x] Prisma: `MealSuggestion` / `WeeklyReport` とマイグレーション
- [x] `AiService` / `AiController`（提案・レポート取得）
- [x] `CronController`（Bearer 検証・時間予算つきバッチ・冪等）
- [x] レポート通知メール（本文生成・エスケープ・1 人 1 通・`notifiedAt` による二重送信防止）＋ 通知設定 API
- [x] `vercel.json`: `crons` 追加、AI 用の関数 `api/ai.js`（`maxDuration` 60）
- [x] e2e: 提案の生成・上限・他家族 404、Cron の認証・冪等性（Fake モデル注入）
- [x] `npm run build`（ESM 互換チェック）・lint・test・test:e2e
### アプリ（Flutter）
- [x] ホームの NavigationBar に「AIによる分析」タブ
- [x] 食事の提案カード（直近の提案表示・生成ボタン・生成中表示・エラー/上限表示）
- [x] 習慣レポート一覧（最新を展開表示）
- [x] メール通知のオン/オフのスイッチ
- [x] モデル・providers・テスト（`flutter analyze && flutter test`、API 契約テスト）
### ドキュメント
- [x] README・`.env.example` に LLM / Cron の設定を追記
### レビュー
- [x] code-reviewer / security-reviewer を実行し、Critical・High を解消

## 確認結果（2026-09-29）
1. タブ: 「AIによる分析」タブを追加する
2. 提案の上限: こども 1 人あたり 1 日 3 回
3. レポートの期間: 前週金曜 17:00 〜 今週金曜 17:00 の 7 日間
4. 通知: メールのみ（プッシュ通知はやらない）。配信停止の設定あり

## 今回やらないこと
- プッシュ通知（通知はメールのみ）
- 食事記録への栄養素・量の項目追加、アレルギー情報の登録
- 提案のストリーミング表示（生成完了後にまとめて表示）
- LLM の利用量の可視化・課金管理

## レビュー

### 実装結果
- バックエンド: `src/ai/`（`ai-model.ts` で LLM を切り替え、LangGraph の 2 つのグラフ、`AiService`、`WeeklyReportJob`、`CronController`）、`ai_usages` などのテーブル（マイグレーション 3 つ）、`api/ai.js`（AI 用の関数）
- アプリ: 「AIによる分析」タブ（食事の提案・習慣レポート・メール通知のスイッチ）
- 依存: langchain 1.5.14 / @langchain/core 1.2.13 / @langchain/langgraph 1.4.18 / @langchain/google-genai 2.3.2 / @langchain/openai 1.6.0 / @langchain/anthropic 1.5.11
  - `overrides.undici: ^6.29.0`: openai の peer 依存（`>=5 <9`）が、開発用の `@nestjs/mau` が固定する脆弱な 6.20.1 で満たされていたため、修正済みの版に上げた

### 検証
- バックエンド: 単体 39 件・e2e 34 件（Fake の LLM とメールに差し替え）、`tsc`、lint、`npm run build`（ESM 互換チェック）すべて成功
- 3 つのプロバイダ（google / openai / anthropic）それぞれで、`--no-experimental-require-module`（Vercel と同じ条件）で起動できることを確認（ダミーのキー、外部には接続しない）
- アプリ: `flutter analyze`、`flutter test`（25 件。タブのウィジェットテストを含む）、API 契約テスト（ローカルの API に対して実行）すべて成功
- 実際の LLM（Gemini）での生成は、キーを扱わない方針のため未確認。デプロイ後に `GOOGLE_API_KEY` を設定して動作確認が必要

### レビュー（code-reviewer / security-reviewer、各 3 回）
- 1 回目の High と対応
  - Cron の処理量が少なく、作り切れないと通知が止まる → 17〜23 時に毎時実行、ランダムな順、並列 6、通知を「全員分できた次の回」か「最後の回」に
  - 食事の提案が 60 秒を超えうる → LLM の上限を 1 回 20 秒に。強制終了で残った行は 2 分後に回数から外す
  - こどもを増やせば LLM を無制限に呼べる → こども 10 人まで、失敗も試行として数える、全体の上限
- 2 回目の High と対応
  - こどもを削除すると回数が戻る → 削除で消えない `ai_usages` でユーザー単位（20 回、新規アカウント 6 回）と全体（1000 回）を数える
  - メール送信を含めて 60 秒を超えうる → 1 回の実行では生成か通知の一方だけ
- 3 回目: Critical・High・Medium なし

### 既知の制限・残課題（Low・今回は対応しない）
- 生成が失敗し続けるこどもが 1 人いると、候補が 0 件にならないため、全員の通知が最後の回（23:00）まで遅れる
- 名前の伏せ字はベストエフォート（愛称・漢字とかなの違いは防げない）。食べ物と同じ名前（もも・いちご等）のこどもは、メモの食べ物名も伏せられ、提案の質が下がることがある
- 通知は「通知済みにしてから送る」ので、締め切り（42 秒）までに送れなかった分は再送しない（最大 1 回）
- メールアドレスの確認がない。通知メールにワンクリックの配信停止リンク・`List-Unsubscribe` がない
- 全体の上限に達したときの外部アラートがない（警告ログのみ）
- `ai_usages`・失敗した `meal_suggestions` の古い行を消す処理がない（数えるのは当日分だけなので、性能の問題はすぐには出ない）
- マイグレーションが 3 つに分かれている（1 つ目をテスト DB に適用したあとの修正のため。DB の初期化には利用者の同意が必要なので、分けたままにした。本番未適用なので、1 つにまとめたい場合はテスト DB を初期化してから作り直す）
- デプロイ前の確認: Vercel のプランの Cron の件数・頻度の上限（7 件・週 1 回ずつ）、`api/ai.js` のコールドスタートの時間（通知の回は起動 10 秒で上限ちょうど）
- OpenAI の既定モデル名 `gpt-5.4-mini` は命名規則からの推定。切り替える場合は `LLM_MODEL` で正確な名前を指定する

