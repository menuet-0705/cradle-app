// 実際の Claude API で、食事の提案（と任意で週次レポート）を 1 件ずつ生成して確認する。
// DB は使わない。サンプルの記録を渡し、構造化出力が検証を通るかを見る（実際に課金される: 数円〜数十円）。
//
//   ANTHROPIC_API_KEY=... npm run ai:smoke            # 食事の提案のみ
//   ANTHROPIC_API_KEY=... npm run ai:smoke -- --report # 週次レポート（Batch。完了まで最大 10 分待つ）
import { AnthropicInsightsModel } from '../dist/insights/insights-model.js';
import { loadConfig } from '../dist/config/env.js';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY を設定してください');
  process.exit(1);
}

// DB・JWT はこのスクリプトでは使わないので、検証を通すためのダミー値を入れる
const config = loadConfig({
  ...process.env,
  DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
  JWT_ACCESS_SECRET: 'ai-smoke-unused-secret-0123456789abcdef',
  NODE_ENV: 'development',
});
const model = new AnthropicInsightsModel(config);
console.log(`model: ${model.modelName}`);

const child = { ageMonths: 8, sex: '男の子', avoidFoods: '卵' };
const meals = [
  ['09-20(日)', '11:30', 'にんじんとかぼちゃのペースト', 'ぜんぶ', '好き'],
  ['09-21(月)', '11:30', '10倍がゆ、しらす', '半分くらい', 'ふつう'],
  ['09-22(火)', '11:30', 'ほうれん草のペースト', '少し', '苦手'],
  ['09-24(木)', '11:30', 'さつまいもとりんごの煮物', 'ぜんぶ', '好き'],
  ['09-26(土)', '11:30', '豆腐とにんじんのおかゆ', 'ぜんぶ', '好き'],
].map(([date, time, food, amount, reaction]) => ({
  date,
  time,
  food,
  amount,
  reaction,
}));

const started = Date.now();
const suggestion = await model.suggestMeals({
  today: '2026-09-29(火)',
  nextMeal: '昼食',
  child,
  milkLast7Days: { averageMlPerDay: 720, averageTimesPerDay: 5 },
  mealsLast30Days: meals,
});
console.log(`\n== 食事の提案（${((Date.now() - started) / 1000).toFixed(1)} 秒）==`);
console.log(JSON.stringify(suggestion, null, 2));
const text = JSON.stringify(suggestion);
if (text.includes('はちみつ')) console.warn('!! 1 歳未満にはちみつが含まれています');

if (process.argv.includes('--report')) {
  const day = (milkMl, sleepMinutes, food) => ({
    milkMl,
    milkTimes: 5,
    sleepMinutes,
    sleepTimes: 3,
    meals: food
      ? [{ time: '11:30', food, amount: 'ぜんぶ', reaction: '好き' }]
      : [],
  });
  const batchId = await model.submitWeeklyReports([
    {
      customId: 'smoke-1',
      input: {
        period: '2026-09-18(金) 17:00 〜 2026-09-25(金) 17:00',
        child,
        thisWeek: {
          summary: {
            fullDaysWithRecords: 6,
            averageMilkMlOnDaysWithMilk: 700,
            averageSleepMinutesOnDaysWithSleep: 780,
            mealCount: 5,
          },
          days: {
            '2026-09-18(金)': day(720, 800, 'にんじんのペースト'),
            '2026-09-19(土)': day(700, 760, '10倍がゆ'),
            '2026-09-20(日)': day(680, 790, null),
          },
          weights: [{ date: '2026-09-20(日)', kg: 8.1 }],
        },
        lastWeek: {
          fullDaysWithRecords: 6,
          averageMilkMlOnDaysWithMilk: 740,
          averageSleepMinutesOnDaysWithSleep: 760,
          mealCount: 4,
        },
        weightBeforeThisWeek: { date: '2026-09-06(日)', kg: 8.0 },
      },
    },
  ]);
  console.log(`\nbatch: ${batchId}（完了を待っています…）`);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 30_000));
    const outcome = await model.fetchWeeklyReports(batchId);
    if (!outcome.ended) continue;
    console.log('\n== 週次レポート ==');
    console.log(JSON.stringify(outcome.results.get('smoke-1'), null, 2));
    process.exit(0);
  }
  console.log('10 分以内に終わりませんでした。後で回収してください:', batchId);
}
