# 20260929 食事の提案・週次の習慣レポート（Claude API）

## 目的
1. **食事の提案**: 過去 1 か月の食事記録から、好きそうな食べ物・不足気味の栄養を補う「次の食事」を提案する（利用者が画面で依頼したときに生成）
2. **習慣レポート**: 毎週金曜の夕方（17:00 JST）に、こどもごとに 1 週間をふりかえるレポートを自動で作る（よかった点・気になる点・傾向）

## 前提と方針

### LLM
- Claude API（`@anthropic-ai/sdk`）。モデルは **`claude-sonnet-5`**（利用者の選択。`CLAUDE_MODEL` で変更可）、adaptive thinking。構造化出力（`output_config.format`）で JSON を受け取り、サーバーでも zod で検証する
  - 「Claude Haiku 5」は存在しない（2026-09 時点）。Haiku 4.5 は引退が 2026-10-15 以降と近いため不採用
- レポートは Batches API（50% 安い・非同期）で作る。拒否（refusal）・解析失敗は「生成できませんでした」として扱う
- 環境差異は環境変数だけ: `ANTHROPIC_API_KEY`（未設定なら提案 API は 503、レポート生成はスキップ）、`CLAUDE_MODEL`、`CRON_SECRET`
- e2e テストでは Claude の呼び出しを差し替える（実 API を呼ばない・費用ゼロ）

### 安全性（乳幼児の食事・健康に関わるため）
- 医療的な診断・断定はしない。体重減少・極端な偏りなど気になる兆候は「かかりつけ医・保健師への相談」を促す
- 月齢に合わない食品（1 歳未満のはちみつ、丸のみしやすい形状など）は提案しない。アレルギー・避けたい食材は必ず除外
- 画面に「一般的な情報であり、医療上の助言ではありません」を常に表示
- 個人情報の最小化: こどもの名前・家族の情報は送らない。送るのは月齢・性別・記録（日時・量・食事メモ）のみ

### データ（記録の拡充）
- 食事記録に任意項目を追加: **食べた量**（ぜんぶ / 半分くらい / 少し / 食べなかった）・**反応**（好き / ふつう / 苦手）。「好きそうな食べ物」の根拠にする
- こどもに任意項目を追加: **アレルギー・避けたい食材**（自由記述）
- 既存の記録はそのまま使える（項目は任意）

### 習慣レポートの生成（Vercel Cron + Batches API。Hobby プランで動く構成）
- 金曜 08:00 UTC（17:00 JST）: 対象（直近 7 日間に記録があるこども）の集計を作り、Batch を 1 件送信。対象期間は「前週金曜 17:00〜今週金曜 17:00（JST）」
- 結果の回収: 毎日 11:00 UTC（20:00 JST）の Cron で未回収の Batch を回収（Hobby の Cron は実行時刻が最大 59 分ずれるため、送信から間隔をあける）。加えて、アプリで「ふりかえり」を開いたときにも未回収分を回収する（早く届く）
- Vercel Cron は GET で呼ばれ、`CRON_SECRET` を設定すると `Authorization: Bearer <CRON_SECRET>` が付く
- レポートができたら、家族全員にメールで知らせる（招待と同じ SMTP。メール未設定なら送らない）
- 集計（ミルク量・回数、睡眠時間、体重の変化、食事の内容と反応）はサーバーで計算してから渡す（数値は LLM に計算させない）
- 同じこども・同じ週のレポートは 1 件だけ（再実行しても重複しない）
- Cron のエンドポイントは `Authorization: Bearer <CRON_SECRET>` がないと 401

### 食事の提案（同期）
- 画面の「次の食事を提案してもらう」で生成。こどもごとに最新の結果を保存し、同じ日は保存済みを返す（再生成は 1 日 3 回まで）
- Vercel Function の最大実行時間を延ばす（現状 10 秒 → 60 秒）

## 仕様（案）

### データモデル
- `Record` に `mealAmount`（enum: ALL / HALF / LITTLE / NONE, 任意）, `mealReaction`（enum: LIKED / NEUTRAL / DISLIKED, 任意）
- `Child` に `avoidFoods`（text, 任意, 500 文字）
- `MealSuggestion`（childId, content JSON, model, createdAt, createdById）
- `WeeklyReport`（childId, weekStart(date), status: PENDING/READY/FAILED, content JSON, batchId, requestId, model, createdAt, readyAt）unique(childId, weekStart)

### API（/api/v1）
| メソッド | パス | 説明 |
|---|---|---|
| POST | `/children/:id/meal-suggestions` | 提案を生成（1 日 3 回まで） |
| GET | `/children/:id/meal-suggestions/latest` | 最新の提案 |
| GET | `/children/:id/weekly-reports` | レポート一覧（新しい順） |
| GET | `/children/:id/weekly-reports/:reportId` | レポート詳細 |
| GET | `/cron/weekly-reports/submit` | （Cron 専用）Batch 送信 |
| GET | `/cron/weekly-reports/collect` | （Cron 専用）結果回収 |

### 出力の形（構造化出力）
- 提案: `{ summary, suggestions: [{ title, foods[], reason, nutrients[], tips }], cautions[] }`
- レポート: `{ headline, goodPoints[], concerns[], trends[], nextWeekTips[], consultDoctor: boolean, consultReason? }`

### 画面
- こども画面に 3 つ目のタブ「ふりかえり」: 上部に「次の食事を提案」、下部に週次レポート一覧 → 詳細
- 食事の記録画面に「食べた量」「反応」、こどもの編集画面に「アレルギー・避けたい食材」

## 作業項目
- [x] backend: Prisma（記録・こどもの項目追加、MealSuggestion / WeeklyReport）＋マイグレーション
- [x] backend: Claude クライアント（env 切替・テスト差し替え）、プロンプト・スキーマ
- [x] backend: 集計（1 か月の食事 / 1 週間の生活リズム）
- [x] backend: 食事の提案 API（回数制限・保存）
- [x] backend: 週次レポート（Cron: submit / collect、Batches API、冪等性、完成メール）＋ `vercel.json` の crons・maxDuration
- [x] backend: e2e（Claude を差し替えて提案・レポートの流れ、他家族のアクセス不可、Cron の認証）
- [x] mobile-app: 食事記録・こどもの項目追加、「ふりかえり」タブ（提案・レポート一覧・詳細）
- [x] mobile-app: テスト
- [ ] 実 API での確認（少量・費用は数十円程度）→ この環境に API キーがないため未実施。`npm run ai:smoke` を用意（模擬サーバーでリクエストの形・解析・Batch の流れは確認済み）
- [x] README（ANTHROPIC_API_KEY / CRON_SECRET、Cron の説明）
- [x] code-reviewer / security-reviewer（4 ラウンド）
- [x] 追加: 家族ごとの AI 利用の同意（レビューの指摘を受けて利用者が選択）

## 費用の目安（Claude Sonnet 5: 入力 $2 / 出力 $10 per 1M tokens）
- 提案 1 回: 入力 約 4〜8K・出力 約 1.5〜3K（思考含む）→ 約 $0.02〜0.05
- レポート 1 件: 同程度、Batches で半額 → 約 $0.01〜0.03 / こども / 週
- 上限: 提案はこども 3・人 10・家族 10・サービス全体 300（`AI_SUGGESTIONS_DAILY_MAX`）/ 日。レポートは同意した家族のみ、1 回 200 件まで → 最悪でも提案 約 $15 / 日

## レビュー

### 検証結果
- backend: unit 28・e2e 37 pass（Claude・メール送信は差し替え）。tsc / oxlint OK、`npm run build`（require(esm) 無効での起動確認）OK
- mobile-app: analyze 0 件、テスト 25 pass
- 模擬 Claude API（`ANTHROPIC_BASE_URL` をローカルに向ける）で、実際に送るリクエスト（モデル・adaptive thinking・effort・構造化出力のスキーマ）と、解析・Batch の作成→状態→結果の流れを確認
- **未実施: 実際の Claude API での生成**（この環境に API キーがない）。`ANTHROPIC_API_KEY=... npm run ai:smoke [-- --report]` で確認できる

### 反映した指摘（主なもの）
- (High) 提案の回数制限を同時リクエストですり抜けられる・失敗が回数に入らない → Claude を呼ぶ前にロック内で PENDING 行を作って枠を確保、失敗も数える
- (High) こどもを増やすほど費用が増える → 人・家族・サービス全体の上限、こどもは 1 家族 10 人まで、プロンプトに入れる記録量の上限
- (High) 締めの金曜（0〜17 時）の記録が集計から漏れる → 日ごとの枠を開始日の 0 時から作る
- (High) Batch の完了が遅いと結果を取る前に失敗扱い → 結果を取りに行った後、50 時間を過ぎたものだけ失敗扱い
- (Medium) 同意なしにこどもの健康情報を米国の事業者へ送信 → 家族の管理者による同意（版つき）、取り消しで作成中のレポートも破棄
- (Medium) 記録に紛れた指示で安全でない提案 → `<data>` 内のエスケープ、生成後のサーバー側チェック（避けたい食材の表記ゆれ・言い換え・「〇〇アレルギー」、1 歳未満のはちみつ）
- (Medium) 依頼失敗で週が抜ける・1 か所の失敗で Cron 全体が止まる・時間切れ → 毎日の Cron で再依頼、段階ごとに独立、Vercel の 60 秒に収まる時間配分
- (Medium) 画面表示のリクエストで全家族の Batch 処理とメール送信 → そのこどもの分だけ・短い制限時間・メールは Cron（notifiedAt で二重送信防止）

### 受け入れたこと・後続
- [ ] **実 API での確認**（キーを設定して `npm run ai:smoke`）。本番公開前に必須
- [ ] Anthropic Console でワークスペースの月額上限・アラートを設定（コード側の上限の最後の砦）
- [ ] 同意の説明文・プライバシーポリシーの法務確認（要配慮個人情報・外国への提供）
- [ ] サービス全体の上限（300/日）を大量の捨てアカウントで使い切られると、その日は全員が使えない（警告ログで検知。メール確認の導入で緩和）
- [ ] Batch 作成の応答が失われた場合、翌日に同じこどもの分を再依頼して二重課金になりうる（1 人 1 週 1 回まで）
- [ ] 同じ週に同意を取り消して再同意しても、その週のレポートは作り直さない
- [ ] 安全チェックは表記の照合による補助（主な言い換えのみ）。避けたい食材は入力フォームで選択式にするとより確実
- メールは 1 日 1 回（20 時）の Cron で送るため、金曜に依頼したレポートの通知は多くが翌日になる（アプリでは先に見られる）
