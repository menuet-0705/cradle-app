import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { ChartKind } from '../generated/prisma/client.js';
import type { AiModel } from './ai-model.js';
import { dataBlock, SAFETY_RULES, sexLabel } from './prompt.js';

/** コメントの元にするグラフのデータ（名前・メモは含めない） */
export type ChartCommentInput = {
  ageMonths: number;
  sex: 'MALE' | 'FEMALE' | null;
} & (
  | {
      chart: 'WEIGHT';
      /** 直近の体重の記録（古い順）。date は利用者の地域の日付（YYYY-MM-DD） */
      weights: { date: string; weightG: number }[];
    }
  | {
      chart: 'MILK';
      /** 直近の 1 日ごとのミルク（古い順。記録のない日は 0） */
      days: { date: string; totalMl: number; count: number }[];
    }
);

const text = (max: number) => z.string().trim().min(1).max(max);

export const chartCommentSchema = z.object({
  headline: text(80).describe('グラフから読み取れることの一言のまとめ（1 文）'),
  points: z
    .array(text(150))
    .min(1)
    .max(3)
    .describe(
      'グラフから読み取れるポイント（2〜3 件、各 1 文。具体的な数値に触れる）',
    ),
  advice: text(150).describe('保護者へのひとことアドバイス（1 文）'),
});
export type ChartCommentContent = z.infer<typeof chartCommentSchema>;

const INSTRUCTIONS: Record<ChartKind, string[]> = {
  WEIGHT: [
    'こどもの体重の推移のグラフについて、保護者向けの短いコメントを書いてください。',
    '増え方のペース（1 日・1 週間あたりの増加量など）に触れてください。月齢の一般的な目安に触れてもよいですが、個人差が大きいので断定しないでください。',
    '記録の間隔が空いている・記録が少ない場合は、そのことを踏まえて控えめに書いてください。',
  ],
  MILK: [
    'こどもの直近の 1 日ごとのミルクの量のグラフについて、保護者向けの短いコメントを書いてください。',
    '1 日の合計量・回数の推移や、増えている・減っている・安定しているといった傾向に触れてください。',
    '0 ml の日は記録していないだけの可能性があるので、飲んでいないと決めつけないでください。今日の分は途中までの集計です。',
  ],
};

/** グラフのデータから、まとめ・ポイント・アドバイスを書く（1 回の呼び出し） */
export function writeChartComment(
  model: AiModel,
  input: ChartCommentInput,
): Promise<ChartCommentContent> {
  const data = input.chart === 'WEIGHT' ? input.weights : input.days;
  return model.generate(
    chartCommentSchema,
    [
      new SystemMessage(SAFETY_RULES),
      new HumanMessage(
        [
          ...INSTRUCTIONS[input.chart],
          '保護者を責めない、前向きでやさしい言葉で書いてください。',
          `こども: 月齢 ${input.ageMonths} か月、性別 ${sexLabel(input.sex)}`,
          'グラフのデータ:',
          dataBlock(data),
        ].join('\n\n'),
      ),
    ],
    { name: `chart_comment_${input.chart.toLowerCase()}` },
  );
}
