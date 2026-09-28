import { z } from 'zod';

// Claude の構造化出力の形。API 側で JSON スキーマとして強制し、受け取った後も zod で検証する。
// 文字数・件数の上限はスキーマでは強制しない（少し超えただけで生成全体が失敗扱いになるため）。
// 目安は説明文で伝え、受け取った後に clamp* で切り詰める

export const mealSuggestionContentSchema = z.object({
  summary: z
    .string()
    .describe('この 1 か月の食事の傾向（2〜3 文、200 文字程度）'),
  suggestions: z
    .array(
      z.object({
        title: z.string().describe('献立の名前（20 文字程度）'),
        foods: z.array(z.string()).describe('使う食材（5 個程度まで）'),
        reason: z
          .string()
          .describe('なぜこの献立か。好み・栄養の観点（100 文字程度）'),
        nutrients: z.array(z.string()).describe('補える栄養素（3 個程度まで）'),
        tips: z
          .string()
          .describe('月齢に合わせた形状・固さ・量のコツ（100 文字程度）'),
      }),
    )
    .describe('提案する献立（2〜3 件）'),
  cautions: z
    .array(z.string())
    .describe('注意点（アレルギー・食べ方など。なければ空配列）'),
});
export type MealSuggestionContent = z.infer<typeof mealSuggestionContentSchema>;

export const weeklyReportContentSchema = z.object({
  headline: z.string().describe('今週をひとことで（30 文字程度）'),
  goodPoints: z.array(z.string()).describe('よかった点（1〜4 件）'),
  concerns: z
    .array(z.string())
    .describe('気になる点・よくなかった点（0〜4 件）'),
  trends: z.array(z.string()).describe('先週と比べた傾向（0〜4 件）'),
  nextWeekTips: z
    .array(z.string())
    .describe('来週の過ごし方のヒント（1〜3 件）'),
  consultDoctor: z
    .boolean()
    .describe('かかりつけ医・保健師への相談を勧める兆候があれば true'),
  consultReason: z
    .string()
    .describe('consultDoctor が true の理由。false なら空文字'),
});
export type WeeklyReportContent = z.infer<typeof weeklyReportContentSchema>;

const cut = (s: string, max: number) => {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const cutList = (items: string[], maxItems: number, maxLen = 200) =>
  items
    .map((s) => cut(s, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);

/** 画面が崩れない長さ・件数に収める */
export function clampMealSuggestion(
  c: MealSuggestionContent,
): MealSuggestionContent {
  return {
    summary: cut(c.summary, 400),
    suggestions: c.suggestions.slice(0, 3).map((s) => ({
      title: cut(s.title, 60),
      foods: cutList(s.foods, 8, 40),
      reason: cut(s.reason, 300),
      nutrients: cutList(s.nutrients, 5, 30),
      tips: cut(s.tips, 300),
    })),
    cautions: cutList(c.cautions, 5),
  };
}

export function clampWeeklyReport(c: WeeklyReportContent): WeeklyReportContent {
  return {
    headline: cut(c.headline, 80),
    goodPoints: cutList(c.goodPoints, 5),
    concerns: cutList(c.concerns, 5),
    trends: cutList(c.trends, 5),
    nextWeekTips: cutList(c.nextWeekTips, 5),
    consultDoctor: c.consultDoctor,
    consultReason: c.consultDoctor ? cut(c.consultReason, 300) : '',
  };
}
