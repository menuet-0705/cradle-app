import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import type { AiModel } from './ai-model.js';
import { dataBlock, formatJst, SAFETY_RULES, sexLabel } from './prompt.js';

export interface ReportRecord {
  type: 'MILK' | 'SLEEP' | 'WEIGHT' | 'MEAL';
  startedAt: Date;
  endedAt: Date | null;
  amountMl: number | null;
  weightG: number | null;
  note: string | null;
}

export interface WeeklyReportInput {
  ageMonths: number;
  sex: 'MALE' | 'FEMALE' | null;
  periodStart: Date;
  periodEnd: Date;
  records: ReportRecord[];
  /** 前週のレポートの集計（傾向の比較用。なければ null）。保存済みの JSON をそのまま LLM に渡すだけなので型は問わない */
  previousSummary: unknown;
}

export interface DaySummary {
  /** JST の日付（YYYY-MM-DD） */
  date: string;
  milkMl: number;
  milkCount: number;
  sleepMinutes: number;
  mealCount: number;
}

/** 画面のサマリー表示と LLM への入力に使う集計値 */
export interface WeeklyReportSummary {
  recordCount: number;
  days: DaySummary[];
  milk: { totalMl: number; count: number; avgMlPerDay: number };
  sleep: { totalMinutes: number; avgMinutesPerDay: number };
  meals: { count: number };
  weight: { firstG: number; lastG: number; changeG: number } | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const jstDate = (d: Date) =>
  new Date(+d + JST_OFFSET_MS).toISOString().slice(0, 10);

/** 期間内の記録を JST の日ごとに集計する（LLM は使わない） */
export function summarizeWeek(
  records: ReportRecord[],
  periodStart: Date,
  periodEnd: Date,
): WeeklyReportSummary {
  // 期間に含まれる JST の日付をすべて並べる（金曜 17:00 起点なので、最初と最後の日は途中まで）
  const days = new Map<string, DaySummary>();
  const lastDate = jstDate(new Date(+periodEnd - 1));
  for (let t = +periodStart; ; t += DAY_MS) {
    const date = jstDate(new Date(t));
    days.set(date, {
      date,
      milkMl: 0,
      milkCount: 0,
      sleepMinutes: 0,
      mealCount: 0,
    });
    if (date >= lastDate) break;
  }

  const inPeriod = records.filter(
    (r) => r.startedAt >= periodStart && r.startedAt < periodEnd,
  );
  const weights: { at: Date; g: number }[] = [];
  for (const r of inPeriod) {
    const day = days.get(jstDate(r.startedAt));
    if (!day) continue;
    switch (r.type) {
      case 'MILK':
        day.milkMl += r.amountMl ?? 0;
        day.milkCount++;
        break;
      case 'SLEEP':
        if (r.endedAt) {
          // 期間をまたぐ睡眠は期間内の分だけ数え、寝始めた日に計上する
          const end = Math.min(+r.endedAt, +periodEnd);
          day.sleepMinutes += Math.max(
            0,
            Math.round((end - +r.startedAt) / 60_000),
          );
        }
        break;
      case 'MEAL':
        day.mealCount++;
        break;
      case 'WEIGHT':
        if (r.weightG != null) weights.push({ at: r.startedAt, g: r.weightG });
        break;
    }
  }

  const list = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const sum = (f: (d: DaySummary) => number) =>
    list.reduce((n, d) => n + f(d), 0);
  const periodDays = Math.max(1, (+periodEnd - +periodStart) / DAY_MS);
  const milkMl = sum((d) => d.milkMl);
  const sleepMinutes = sum((d) => d.sleepMinutes);
  weights.sort((a, b) => +a.at - +b.at);
  const first = weights.at(0);
  const last = weights.at(-1);

  return {
    recordCount: inPeriod.length,
    days: list,
    milk: {
      totalMl: milkMl,
      count: sum((d) => d.milkCount),
      avgMlPerDay: Math.round(milkMl / periodDays),
    },
    sleep: {
      totalMinutes: sleepMinutes,
      avgMinutesPerDay: Math.round(sleepMinutes / periodDays),
    },
    meals: { count: sum((d) => d.mealCount) },
    weight:
      first && last
        ? { firstG: first.g, lastG: last.g, changeG: last.g - first.g }
        : null,
  };
}

const text = (max: number) => z.string().trim().min(1).max(max);

const weeklyReportContentSchema = z.object({
  headline: text(80).describe('1 週間をひとことで表す見出し'),
  goodPoints: z
    .array(text(200))
    .min(1)
    .max(4)
    .describe('よかった点（1〜4 件、各 1 文）'),
  concerns: z
    .array(text(200))
    .max(4)
    .describe('気になる点（0〜4 件、各 1 文。なければ空）'),
  trends: z
    .array(text(200))
    .min(1)
    .max(4)
    .describe('ミルク・睡眠・食事・体重の傾向（1〜4 件、各 1 文）'),
});
export type WeeklyReportContent = z.infer<typeof weeklyReportContentSchema>;

const WeeklyReportState = Annotation.Root({
  input: Annotation<WeeklyReportInput>,
  summary: Annotation<WeeklyReportSummary>,
  content: Annotation<WeeklyReportContent>,
});

/**
 * 習慣レポート:
 *   summarize（記録を日ごとに集計。コードのみ）
 *   → writeReport（集計と食事メモから、よかった点・気になる点・傾向を書く）
 */
export function buildWeeklyReportGraph(model: AiModel) {
  return new StateGraph(WeeklyReportState)
    .addNode('summarize', ({ input }) => ({
      summary: summarizeWeek(input.records, input.periodStart, input.periodEnd),
    }))
    .addNode('writeReport', async ({ input, summary }) => {
      const meals = input.records
        .filter((r) => r.type === 'MEAL' && r.note)
        .map((r) => ({ at: formatJst(r.startedAt), note: r.note }));
      return {
        content: await model.generate(
          weeklyReportContentSchema,
          [
            new SystemMessage(SAFETY_RULES),
            new HumanMessage(
              [
                'こどもの 1 週間の記録の集計から、保護者向けのふりかえりレポートを書いてください。',
                '「よかった点」「気になる点」「傾向」に分け、具体的な数値に触れながら、保護者を責めない前向きな言葉で書いてください。',
                '記録の抜けもありうるので、記録が少ない項目は断定しないでください。最初と最後の日は途中までの集計です。',
                `こども: 月齢 ${input.ageMonths} か月、性別 ${sexLabel(input.sex)}`,
                `期間: ${formatJst(input.periodStart)} 〜 ${formatJst(input.periodEnd)}（JST）`,
                '今週の集計:',
                dataBlock(summary),
                '前週の集計（比較用。null なら前週のレポートなし）:',
                dataBlock(input.previousSummary),
                '今週の食事メモ:',
                dataBlock(meals),
              ].join('\n\n'),
            ),
          ],
          { name: 'weekly_report' },
        ),
      };
    })
    .addEdge(START, 'summarize')
    .addEdge('summarize', 'writeReport')
    .addEdge('writeReport', END)
    .compile();
}

export type WeeklyReportGraph = ReturnType<typeof buildWeeklyReportGraph>;

export async function runWeeklyReport(
  graph: WeeklyReportGraph,
  input: WeeklyReportInput,
): Promise<{ summary: WeeklyReportSummary; content: WeeklyReportContent }> {
  const { summary, content } = await graph.invoke({ input });
  return { summary, content };
}
