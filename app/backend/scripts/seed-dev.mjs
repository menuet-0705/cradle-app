// 開発・検証環境用: こどもに過去 30 日分のダミーの記録を入れる。本番には使わない。
//
// 使い方（app/backend で実行）:
//   npm run db:seed:dev                         … こどもの一覧
//   npm run db:seed:dev -- <childId>            … ダミーの記録を入れる
//   npm run db:seed:dev -- --remote [<childId>] … localhost 以外（検証環境の Supabase など）に対して実行する
//
// - 接続先は SEED_DATABASE_URL（未指定なら docker compose の既定値）
// - localhost 以外は --remote を付けたときだけ。本番と検証は接続先からは見分けられないので、
//   接続後に表示する接続先（ユーザー・DB）を見て、実行する人が y/N で確かめる（端末から実行するときだけ動く）
//   - SSL で接続する。SEED_DATABASE_CA に CA 証明書（Supabase のダッシュボードから取得）のパスを渡すとサーバーも検証する
//   - Supabase は Session pooler / Direct（5432）で。Transaction pooler（6543）では SET search_path が次の問い合わせに残らない
// - ミルク・睡眠（昼寝と夜）・体重（週 1 回）・食事（生後 5 か月から。1 日 3 食 + 1 日おきにおやつ）
// - 「1 日」は JST で区切る（端末が JST 以外で作った記録とは、日の境目がずれることがある）
// - 食事は「好きなもの（かぼちゃ・さつまいも・バナナ・うどん）が多く、赤身の肉・魚が少ない」傾向にしてあるので、
//   AI の分析では好みと「鉄分が不足気味」などが出るはず
// - 時刻は日付から決まる。同じ記録（食事は 日 × 区分、体重は 日、ミルク・睡眠は 同じ時刻）がすでにあれば入れないので、
//   何度実行しても重複しない。生まれる前と未来の時刻は入れない
//   （時刻の表や salt を変えると過去に入れた分と時刻が変わり重複するので、そのときはダミーを消してから入れ直す）
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import pg from 'pg';

const DAYS = 30;
const JST_MS = 9 * 3600e3;
const DAY_MS = 86400e3;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

const url =
  process.env.SEED_DATABASE_URL ??
  'postgresql://cradle:cradle@localhost:5432/cradle';
let parsed;
try {
  parsed = new URL(url);
} catch {
  // URL 解析エラーには接続文字列（パスワード含む）が載るので、そのまま出さない
  fail('SEED_DATABASE_URL が URL として不正です');
}
const args = process.argv.slice(2);
const remote = args.includes('--remote');
const positional = args.filter((a) => a !== '--remote');
if (positional.length > 1 || positional.some((a) => a.startsWith('-'))) {
  fail('引数は [--remote] [<childId>] だけです');
}
if (!parsed.hostname) fail('SEED_DATABASE_URL にホスト名を書いてください');
const isLocal = LOCAL_HOSTS.has(parsed.hostname);
if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
  fail('SEED_DATABASE_URL は postgres:// か postgresql:// で指定してください');
}
if (!isLocal && !remote) {
  fail(
    'localhost 以外の DB には --remote を付けたときだけ入れられます（本番には使わないでください）',
  );
}
if (!isLocal && parsed.port === '6543') {
  fail(
    'Transaction pooler（6543）では schema の指定が効かないので、Session pooler / Direct（5432）で接続してください',
  );
}
// （URL にポートを書かず PGPORT で 6543 を指定した場合は判定できない。ポートは URL に書く）
const schema = parsed.searchParams.get('schema') ?? 'public';
if (!/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(schema)) {
  fail('schema の名前が不正です');
}
const childId = positional[0];
if (
  childId &&
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    childId,
  )
) {
  fail('こどもの id（UUID）を指定してください');
}

async function list() {
  const { rows } = await client.query(`
    SELECT c.id, c.name, c.birth_date::text AS birth_date,
           count(*) FILTER (WHERE r.type = 'MILK')::int   AS milk,
           count(*) FILTER (WHERE r.type = 'SLEEP')::int  AS sleep,
           count(*) FILTER (WHERE r.type = 'WEIGHT')::int AS weight,
           count(*) FILTER (WHERE r.type = 'MEAL')::int   AS meal
      FROM children c
      LEFT JOIN records r
        ON r.child_id = c.id AND r.started_at >= now() - interval '${DAYS} days'
     GROUP BY c.id
     ORDER BY c.created_at`);
  console.table(rows);
  console.log(
    `件数は直近 ${DAYS} 日分。ダミーの記録を入れるには、こどもの id を引数に付けて実行してください`,
  );
}

async function seed(childId) {
  const { rows } = await client.query(
    `SELECT c.name, c.birth_date::text AS birth_date,
            (SELECT m.user_id FROM family_members m
              WHERE m.family_id = c.family_id ORDER BY m.created_at LIMIT 1) AS user_id
       FROM children c WHERE c.id = $1`,
    [childId],
  );
  if (rows.length === 0) throw new Error('こどもが見つかりません');
  const { name, birth_date: birthDate, user_id: userId } = rows[0];

  const now = Date.now();
  const birthDay = dayNumber(Date.parse(`${birthDate}T00:00:00Z`));
  const today = dayNumber(now + JST_MS);
  const records = [];
  for (let day = Math.max(today - DAYS + 1, birthDay); day <= today; day++) {
    records.push(...recordsOf(day, birthDay));
  }
  const past = records.filter(
    (r) => +r.startedAt <= now && (!r.endedAt || +r.endedAt <= now),
  );

  let inserted = 0;
  await client.query('BEGIN');
  try {
    // 同時に実行されても NOT EXISTS の判定がすり抜けないよう、こどもの行をロックする
    await client.query('SELECT 1 FROM children WHERE id = $1 FOR UPDATE', [
      childId,
    ]);
    for (const r of past) {
      const res = await client.query(
        `INSERT INTO records
                (id, child_id, created_by_id, type, started_at, ended_at, amount_ml, weight_g, meal_slot, note)
         SELECT gen_random_uuid(), $1, $2, $3::"RecordType", $4, $5, $6, $7, $8::"MealSlot", $9
          WHERE NOT EXISTS (
                SELECT 1 FROM records e
                 WHERE e.child_id = $1 AND e.type = $3::"RecordType"
                   AND CASE
                         WHEN e.type = 'MEAL' THEN
                           (e.started_at AT TIME ZONE 'Asia/Tokyo')::date = ($4::timestamptz AT TIME ZONE 'Asia/Tokyo')::date
                           AND e.meal_slot = $8::"MealSlot"
                         WHEN e.type = 'WEIGHT' THEN
                           (e.started_at AT TIME ZONE 'Asia/Tokyo')::date = ($4::timestamptz AT TIME ZONE 'Asia/Tokyo')::date
                         ELSE e.started_at = $4
                       END)`,
        [
          childId,
          userId,
          r.type,
          r.startedAt,
          r.endedAt ?? null,
          r.amountMl ?? null,
          r.weightG ?? null,
          r.mealSlot ?? null,
          r.note ?? null,
        ],
      );
      inserted += res.rowCount;
    }
    await client.query('COMMIT');
  } catch (e) {
    // ROLLBACK の失敗で元のエラーが隠れないようにする
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
  console.log(
    `${name}（${birthDate} 生まれ）に ${inserted} 件入れました（${past.length - inserted} 件はすでにあるので入れていません）`,
  );
}

// ---- 1 日分の記録（日付と月齢だけで決まる） ----

function recordsOf(day, birthDay) {
  const months = monthsOld(birthDay, day);
  // ± 最大 15 分ずらす。日付をまたがないよう、その日の 0:00〜23:59 に収める
  const at = (h, m, salt) =>
    jstTime(
      day,
      0,
      Math.min(Math.max(h * 60 + m + jitter(day, salt, 15), 0), 24 * 60 - 1),
    );
  const records = [];

  for (const [i, [h, m]] of milkTimes(months).entries()) {
    const amount = milkAmount(months) + jitter(day, 10 + i, 2) * 10;
    records.push({
      type: 'MILK',
      startedAt: at(h, m, 10 + i),
      amountMl: amount,
    });
  }

  // 夜は 20:30 ごろ〜翌 6:30 ごろ。昼寝は 1 歳までは 2 回、3 歳までは 1 回
  const naps =
    months < 12
      ? [
          [9, 0, 45],
          [13, 0, 90],
        ]
      : months < 36
        ? [[13, 0, 100]]
        : [];
  for (const [i, [h, m, minutes]] of naps.entries()) {
    const start = at(h, m, 30 + i);
    const end = new Date(+start + (minutes + jitter(day, 40 + i, 20)) * 60e3);
    records.push({ type: 'SLEEP', startedAt: start, endedAt: end });
  }
  const night = at(20, 30, 50);
  const wake = new Date(jstTime(day + 1, 6, 30 + jitter(day, 51, 30)));
  records.push({
    type: 'SLEEP',
    startedAt: night,
    endedAt: wake,
    ...(months >= 3 && day % 5 === 0 && { note: '夜中に 1 回起きた' }),
  });

  if (day % 7 === 0) {
    const weightG = Math.round(
      weightAt((day - birthDay) / 30.44) + jitter(day, 60, 50),
    );
    records.push({ type: 'WEIGHT', startedAt: at(19, 30, 60), weightG });
  }

  if (months >= 5) {
    const menu = months < 12 ? BABY_MENU : TODDLER_MENU;
    for (const [slot, [h, m]] of Object.entries(MEAL_TIMES)) {
      if (slot === 'AFTERNOON_SNACK' && day % 2 === 1) continue; // おやつは 1 日おき
      const list = menu[slot];
      records.push({
        type: 'MEAL',
        startedAt: at(h, m, 70 + h),
        mealSlot: slot,
        note: list[(day * 3 + h) % list.length],
      });
    }
  }
  return records;
}

// 3 か月までは 3 時間おき（睡眠と重なってよい）。3 か月からは起きている時間に飲む（夜の 22 時は寝たまま飲ませる）。3 歳からはなし
function milkTimes(months) {
  if (months < 3) return [0, 3, 6, 9, 12, 15, 18, 21].map((h) => [h, 0]);
  if (months < 12)
    return [
      [7, 30],
      [11, 0],
      [15, 30],
      [18, 0],
      [22, 0],
    ];
  if (months < 36)
    return [
      [7, 30],
      [19, 45],
    ];
  return [];
}

function milkAmount(months) {
  if (months < 1) return 80;
  if (months < 3) return 140;
  if (months < 6) return 180;
  if (months < 12) return 200;
  return 150;
}

// 月齢 → 体重（g）のおおよその目安を直線でつなぐ
function weightAt(months) {
  const points = [
    [0, 3100],
    [3, 6200],
    [6, 7800],
    [12, 9300],
    [24, 12000],
    [36, 14000],
    [72, 20000],
  ];
  const last = points.at(-1);
  if (months >= last[0]) return last[1];
  const i = points.findIndex(([m]) => m > months);
  const [m0, w0] = points[i - 1];
  const [m1, w1] = points[i];
  return w0 + ((w1 - w0) * (months - m0)) / (m1 - m0);
}

// ---- 日付と時刻 ----

// JST の日付を 1970-01-01 からの日数で表す
function dayNumber(msInJst) {
  return Math.floor(msInJst / DAY_MS);
}

function jstTime(day, h, m) {
  return new Date(day * DAY_MS + (h * 60 + m) * 60e3 - JST_MS);
}

function monthsOld(birthDay, day) {
  const b = new Date(birthDay * DAY_MS);
  const d = new Date(day * DAY_MS);
  return (
    (d.getUTCFullYear() - b.getUTCFullYear()) * 12 +
    (d.getUTCMonth() - b.getUTCMonth()) -
    (d.getUTCDate() < b.getUTCDate() ? 1 : 0)
  );
}

// 日付と salt から決まる -range〜+range の整数（再実行しても同じ値になる）
// 整数演算だけで計算するので、Node の版や環境が変わっても同じ値になる
function jitter(day, salt, range) {
  let x = Math.imul(day ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt, 0xc2b2ae35);
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x ^= x >>> 16;
  return ((x >>> 0) % (2 * range + 1)) - range;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ---- 献立 ----

const MEAL_TIMES = {
  BREAKFAST: [7, 30],
  LUNCH: [12, 0],
  AFTERNOON_SNACK: [15, 30],
  DINNER: [18, 30],
};

// 離乳食（〜11 か月）: かぼちゃ・さつまいも・バナナが多く、赤身の肉・魚はほとんどない
const BABY_MENU = {
  BREAKFAST: [
    '10倍がゆ、かぼちゃペースト 完食',
    'パンがゆ、バナナ 完食',
    '10倍がゆ、さつまいもペースト おかわり',
    'おかゆ、にんじんペースト 半分残した',
    'パンがゆ、りんごのすりおろし 完食',
  ],
  LUNCH: [
    'うどんくたくた煮、かぼちゃ 完食',
    'おかゆ、しらす、ほうれん草 ほうれん草は嫌がった',
    'さつまいもがゆ よく食べた',
    'とうふとにんじんのとろとろ煮 半分',
    'うどん、ブロッコリー 完食',
    'かぼちゃとバナナのヨーグルトあえ おかわり',
  ],
  AFTERNOON_SNACK: [
    'バナナ 1/2 本',
    '赤ちゃんせんべい',
    'さつまいもスティック',
    'ヨーグルト',
  ],
  DINNER: [
    'おかゆ、かぼちゃ、とうふ 完食',
    'うどん、にんじん、たまねぎ よく食べた',
    'おかゆ、白身魚（たら）少し 魚は口から出した',
    'さつまいもとりんごの煮物 完食',
    'パンがゆ、かぼちゃスープ 完食',
    'おかゆ、小松菜 あまり食べなかった',
  ],
};

// 幼児食（1 歳〜）: 炭水化物・甘い野菜が多く、赤身の肉・魚が少ない
const TODDLER_MENU = {
  BREAKFAST: [
    '食パン、バナナ、牛乳 完食',
    'おにぎり、かぼちゃの煮物 よく食べた',
    'ロールパン、ヨーグルト 完食',
    'おにぎり、たまご焼き たまごは半分',
    'パンケーキ、いちご おかわり',
  ],
  LUNCH: [
    'うどん、かぼちゃの天ぷら 完食',
    'チャーハン（ごはん・たまご・ねぎ） よく食べた',
    'ナポリタン 完食',
    'さつまいもごはん、みそ汁 おかわり',
    'やきそば、キャベツ キャベツは残した',
    'うどん、ちくわ 完食',
  ],
  AFTERNOON_SNACK: [
    'バナナ',
    'さつまいもスティック',
    'ヨーグルト',
    'せんべい',
    'りんご',
  ],
  DINNER: [
    'ごはん、かぼちゃの煮物、とうふのみそ汁 完食',
    'カレーライス（肉少なめ） ルーだけ食べた',
    'ごはん、鮭少し、ブロッコリー 鮭は嫌がった',
    'うどん、にんじん、たまねぎ よく食べた',
    'ごはん、ハンバーグ 半分残した',
    'ごはん、ほうれん草のおひたし ほうれん草は食べなかった',
  ],
};

// ---- 実行 ----

// pg は ?schema= を解釈しないので外し、search_path で指定する。
// ?host= などで実際の接続先がホストの判定・表示と食い違わないようにするためでもあるので、クエリは必ず全部外す
parsed.search = '';
const client = new pg.Client({
  connectionString: parsed.toString(),
  ...(!isLocal && { ssl: sslOptions() }),
});

try {
  await client.connect();
  const { rows: whoami } = await client.query(
    'SELECT current_user AS u, current_database() AS db',
  );
  // パスワードは出さない。Supabase の pooler は本番と検証でホストが同じで、接続後の current_user も postgres になるので、
  // 環境を見分けられるよう URL のユーザー名（postgres.<project-ref>）も出す（不正な % で落ちないよう decode しない）
  console.log(
    `接続先: ${parsed.username}@${parsed.host}/${whoami[0].db}（DB 上のユーザー: ${whoami[0].u}、schema: ${schema}）`,
  );
  if (isLocal && whoami[0].u !== 'cradle') {
    // localhost がトンネル等でリモートにつながっている場合に備え、docker compose の DB ユーザーであることも確かめる
    throw new Error('docker compose の DB（ユーザー cradle）ではありません');
  }
  if (!isLocal && !(await confirm())) {
    throw new Error('中止しました');
  }
  await client.query(`SET search_path TO "${schema}"`);
  if (childId) {
    await seed(childId);
  } else {
    await list();
  }
} catch (e) {
  // 接続できないときは AggregateError で message が空なので code（ECONNREFUSED 等）を出す
  console.error(e.message || e.code || String(e));
  process.exitCode = 1;
} finally {
  await client.end();
}

// Supabase の証明書は独自の CA で署名されているので、CA を渡されたときだけ検証する
function sslOptions() {
  const caPath = process.env.SEED_DATABASE_CA;
  if (caPath) {
    try {
      return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
    } catch {
      fail('SEED_DATABASE_CA のファイルを読めません');
    }
  }
  console.warn(
    '注意: SEED_DATABASE_CA が未指定なので、通信は暗号化しますがサーバーの証明書は検証しません',
  );
  return { rejectUnauthorized: false };
}

// 本番に入れる事故を防ぐため、表示した接続先を見て人が答える。端末でなければ（パイプ・CI など）中止する
async function confirm() {
  if (!process.stdin.isTTY) {
    console.error('localhost 以外への実行は、確認のため端末から行ってください');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `この DB は検証環境ですか？${childId ? 'ダミーの記録を入れます' : 'こどもの一覧を表示します'}（y/N）: `,
    );
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}
