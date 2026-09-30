# 開発環境（ローカル docker の Postgres）にダミーデータを入れるスクリプト

## 背景

- 以前テスト環境（Supabase）向けに使い捨てで作った `seed-meals.mjs`（こども一覧 + 過去 30 日の食事を投入）を、開発環境で使えるようにしたい
- 旧スクリプトは `meal_slot` 追加（`records_meal_slot_check`: MEAL なら必須）より前のもので、そのままでは INSERT が失敗する

## 方針

- `app/backend/scripts/seed-dev.mjs` としてリポジトリに置く（使い捨てにしない）
- 接続先: `SEED_DATABASE_URL`、未指定ならローカル docker の既定値（`.env.example` と同じ公開値）
- 安全策: ホストが localhost / 127.0.0.1 以外なら拒否（誤って Supabase に入れない）
- 引数なし → こども一覧、`<childId>` → 過去 30 日分のダミー記録を投入
- 食事には `meal_slot` を入れる（朝食 / 昼食 / おやつ（午後）/ 夕食）
- 冪等にする: 時刻は日付から決まるようにし、同じ記録（食事は こども×日×区分）がすでにあれば入れない → 再実行しても重複しない（旧 `--force` は不要）

## TODO

- [x] スクリプト作成（meal_slot 対応・ローカル限定・冪等）。範囲は利用者の選択で全種類（ミルク・睡眠・体重・食事）
- [x] ローカルの cradle_test で投入 → 再実行で 0 件追加になることを確認
- [ ] ~~アプリの API（GET records）で読めることを確認~~ → 未実施。DB の CHECK 制約とアプリの不変条件（食事 日×区分 1 件・体重 日 1 件）を SQL で確認した
- [x] code-reviewer / security-reviewer（各 2 回）

## レビュー

### 確認したこと（cradle_test、生後 3 日 / 9 か月 / 17 か月 / 4 歳のこども）

- 生まれる前の記録 0 件、未来の記録 0 件、2 回目の実行で追加 0 件
- 食事の 日 × 区分 の重複 0 件。3 か月以上で起きている時間帯のミルク・食事と睡眠の重なり 0 件
- 異常系: UUID でない id / 存在しない id / localhost 以外 / 不正 URL / socket: / 接続拒否 / 認証失敗 / cradle 以外のユーザー → いずれも短いメッセージで exit 1

### レビュー

- security-reviewer: Critical/High なし。Low（トンネル経由のリモート・プロトコル未確認・ROLLBACK で元のエラーが消える・接続エラーの出し方）はすべて対応
  - 接続後に current_user = 'cradle' を確認、protocol を postgres:/postgresql: に限定、[::1] を許可リストから削除
- code-reviewer: Medium 1 件（誕生日 0 時のミルクが前日に入る）→ 時刻をその日の中に収めて修正
  - Low 対応: 整数ハッシュの jitter、ちょうど 30 日、3 歳からミルク・昼寝なし、ミルク・おやつと睡眠の重なり解消、同時実行のロック
  - 残した Low / Info: 3 か月未満の 0:00 ミルクが 0:00 ちょうどに寄る、一覧の件数は now()-30日 で数える（投入は JST 30 日分）、自動テストなし（開発専用スクリプトのため）


## 追加: 検証環境（Supabase）にも入れられるようにする

- 依頼: localhost 制約を外したい
- 判断: 丸ごと外すと本番にも入れられるので、`--remote` を付けたときだけ localhost 以外を許可する（オプトイン）
  - 本番と検証は同じプーラーのホストを使うことがあり、接続先から自動では見分けられない → 最初に接続先（ユーザー@ホスト/DB、schema）を表示し、実行する人が確かめる。パスワードは出さない
  - `current_user = 'cradle'` の確認は `--remote` なしのときだけ
- [x] 実装
- [x] 確認: フラグなしのリモートは拒否 / `--remote` は前後どちらでも可 / npm 経由 / ローカルは従来どおり / 表示にパスワードが出ない
- [x] code-reviewer / security-reviewer（1 回目）
  - High（code）/ Medium（security）: クエリを全部外すので sslmode も消え、リモートが平文になる
    → localhost 以外は常に SSL。`SEED_DATABASE_CA` があれば証明書も検証、なければ暗号化のみ（警告を出す）
  - Medium: 接続先を表示してすぐ書き込むので確認になっていない
    → 接続後に実際の current_user / current_database を表示し、端末で y/N を聞く。端末でなければ中止（一覧も対象）
  - Medium（code）: Transaction pooler（6543）では SET search_path が残らない → 6543 は拒否して 5432 を案内
  - Medium（code）: --remote で localhost の current_user 確認が外れる → 確認は localhost なら常に行う
  - Low: decodeURIComponent の例外 → 表示は接続後の current_user に。未知の引数・余分な引数は拒否。ローカルでも接続先を表示
- [x] 確認（自己署名証明書で SSL を有効にした一時的な Postgres を使用）
  - 端末でない → 中止 / n → 中止 / y → 341 件、再実行 0 件、生まれる前 0 件
  - CA あり → 検証して接続 / 違う CA → 拒否 / SSL 非対応のサーバー → 拒否（平文に落ちない）
  - 6543 拒否 / `junk`・`-r`・`--remote=1` を拒否 / ローカルは従来どおり
- [x] code-reviewer / security-reviewer（2 回目）: Critical/High なし。1 回目の指摘はすべて解消
  - Medium（security）: Supabase の pooler では本番・検証でホストが同じで current_user も postgres → 表示に URL のユーザー名（postgres.<project-ref>）を追加
  - Low 対応: CA を読めないときは短いメッセージで終了、ホスト名のない URL を拒否、PGPORT で 6543 を指定した場合は判定できない旨をコメント
  - 残した Low / 提案: CA 未指定だと証明書を検証しない（警告は出す）/ さらに固くするなら検証 DB に目印（例: `ALTER DATABASE ... SET app.env = 'staging'`）を置いて照合 / 本物の Supabase（Session pooler・Direct）での CA 検証は未確認

## 追加: README

- [x] README の「ローカル起動」に「ダミーデータ」の節を追加（ローカル・検証環境の使い方と注意）。ドキュメントのみの変更なのでレビューは省略
