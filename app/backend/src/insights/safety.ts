import type {
  MealSuggestionContent,
  WeeklyReportContent,
} from './insights.schemas.js';

// プロンプトでの指示に加え、生成後にもサーバー側で確認する
// （記録に紛れた指示などで安全でない提案が出ても、画面には出さない）

/** 表記ゆれをそろえる: 全角・半角（NFKC）、カタカナ→ひらがな、英字は小文字 */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .toLowerCase();
}

const HONEY = /はちみつ|蜂蜜|はにー|honey/;

// 主なアレルゲンの言い換え（入力した表記と違う書き方で提案されても除外できるように）
const SYNONYMS: [string[], string[]][] = [
  [
    ['卵', 'たまご', '玉子'],
    ['卵', 'たまご', '玉子', 'えっぐ'],
  ],
  [
    ['小麦', 'こむぎ'],
    ['小麦', 'こむぎ', 'ぱん', 'うどん', 'ぱすた', 'そうめん'],
  ],
  [
    ['そば', '蕎麦'],
    ['そば', '蕎麦'],
  ],
  [
    ['えび', '海老'],
    ['えび', '海老', 'しゅりんぷ'],
  ],
  [
    ['かに', '蟹'],
    ['かに', '蟹'],
  ],
  [
    ['落花生', 'ぴーなっつ'],
    ['落花生', 'ぴーなっつ'],
  ],
  // 「乳」は「牛乳」「乳製品」も含む。「豆乳」なども除外されうるが、除外が増えるだけなので安全側
  [['乳'], ['乳', 'みるく', 'よーぐると', 'ちーず', 'ばたー']],
  [['大豆'], ['大豆', '豆腐', '豆乳', '納豆', '味噌', 'みそ', 'きなこ']],
  [
    ['ごま', '胡麻'],
    ['ごま', '胡麻'],
  ],
  [
    ['くるみ', '胡桃'],
    ['くるみ', '胡桃'],
  ],
];

// 「特になし」「など」などは食材として扱わない（普通の献立名に含まれて、提案を誤って除外しないように）
const NOT_FOODS = new Set([
  'なし',
  '特になし',
  'ない',
  '無し',
  'ありません',
  'など',
  '等',
  '少量',
  '加熱',
  'ok',
  '加熱はok',
]);

/** 「アレルギー・避けたい食材」の自由記述を、照合に使う語（表記ゆれ・言い換えを含む）に分ける */
export function avoidFoodTokens(avoidFoods: string | null): string[] {
  if (!avoidFoods) return [];
  // 括弧の中も食材として扱う（「アレルギー（卵・乳）」の卵・乳を落とさない）。
  // 「卵（加熱は OK）」の「加熱はok」のような補足が語として残っても、除外が増えるだけで安全側
  const tokens = normalize(avoidFoods)
    // 「乳アレルギー」「卵除去」「えびng」などの言い回しを食材名だけにする
    .replace(/あれるぎー|除去|禁止|不可|だめ|ng/g, ' ')
    .split(/[\s、,/・;。()（）「」【】［］〔〕[\]]+/)
    .map((t) => t.trim())
    // ひらがな 1 文字（「な」など）はほぼ全ての文に含まれるので照合に使わない
    .filter((t) => t.length > 0 && !NOT_FOODS.has(t) && !/^[ぁ-ゖ]$/.test(t));
  const expanded = new Set(tokens);
  for (const t of tokens) {
    for (const [keys, words] of SYNONYMS) {
      if (keys.some((k) => t.includes(k)))
        words.forEach((w) => expanded.add(w));
    }
  }
  return [...expanded];
}

export interface SafetyContext {
  ageMonths: number;
  avoidFoods: string | null;
}

function isUnsafe(text: string, ctx: SafetyContext): boolean {
  const t = normalize(text);
  if (ctx.ageMonths < 12 && HONEY.test(t)) return true;
  return avoidFoodTokens(ctx.avoidFoods).some((token) => t.includes(token));
}

/**
 * 避けたい食材・月齢に合わない食品（1 歳未満のはちみつ）を含む献立を取り除く。
 * 照合は献立名と食材だけ（理由・コツの「卵は使わずに」などの注意書きで誤って除外しないように）。
 * 1 件も残らなければ null（提案として扱わない）。プロンプトでの指示を補う最後の砦であり、万能ではない
 */
export function filterUnsafeSuggestions(
  content: MealSuggestionContent,
  ctx: SafetyContext,
): MealSuggestionContent | null {
  const suggestions = content.suggestions.filter(
    (s) => !isUnsafe([s.title, ...s.foods].join(' '), ctx),
  );
  if (suggestions.length === 0) return null;
  return { ...content, suggestions };
}

/**
 * レポートの前向きな項目（見出し・よかった点・傾向・ヒント）から同じ条件のものを取り除く。
 * 気になる点・相談の理由は注意喚起として食材名を含みうるので対象外。
 * よかった点・ヒントがすべて消えたら null（レポートとして扱わない）
 */
export function filterUnsafeReport(
  content: WeeklyReportContent,
  ctx: SafetyContext,
): WeeklyReportContent | null {
  const keep = (items: string[]) => items.filter((t) => !isUnsafe(t, ctx));
  const goodPoints = keep(content.goodPoints);
  const nextWeekTips = keep(content.nextWeekTips);
  const hadPositive =
    content.goodPoints.length + content.nextWeekTips.length > 0;
  if (hadPositive && goodPoints.length + nextWeekTips.length === 0) return null;
  return {
    ...content,
    headline: isUnsafe(content.headline, ctx)
      ? '今週のふりかえり'
      : content.headline,
    goodPoints,
    trends: keep(content.trends),
    nextWeekTips,
  };
}
