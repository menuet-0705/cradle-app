import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import type { AiModel } from './ai-model.js';
import { dataBlock, SAFETY_RULES, sexLabel } from './prompt.js';

export interface MealSuggestionInput {
  ageMonths: number;
  sex: 'MALE' | 'FEMALE' | null;
  /** 過去 1 か月の食事記録（新しい順）。at は JST の日時 */
  meals: { at: string; note: string }[];
}

const text = (max: number) => z.string().trim().min(1).max(max);

const mealAnalysisSchema = z.object({
  preferences: z
    .array(text(200))
    .min(1)
    .max(3)
    .describe('記録から読み取れる食の好み・傾向（1〜3 件、各 1 文）'),
  frequentFoods: z.array(text(50)).max(10).describe('よく食べている食材・料理'),
  possiblyLacking: z
    .array(
      z.object({
        nutrient: text(30).describe('栄養素の名前（例: 鉄分）'),
        reason: text(200).describe('不足気味と考えた理由'),
      }),
    )
    .max(3)
    .describe('記録から見て不足気味かもしれない栄養（なければ空）'),
});
export type MealAnalysis = z.infer<typeof mealAnalysisSchema>;

const mealPlanSchema = z.object({
  suggestions: z
    .array(
      z.object({
        dish: text(60).describe('料理名'),
        reason: text(200).describe(
          'この料理をすすめる理由（好み・栄養の観点）',
        ),
        nutrients: z.array(text(30)).max(5).describe('補える栄養素'),
        // 任意項目の扱いはプロバイダごとに違う（OpenAI の strict モードは必須項目のみ）ので必須にする
        caution: text(200).describe('月齢に応じた調理・食べさせ方の注意点'),
      }),
    )
    .length(3),
});

/** 保存・応答する提案の内容 */
export type MealSuggestionContent = Pick<
  MealAnalysis,
  'preferences' | 'possiblyLacking'
> &
  z.infer<typeof mealPlanSchema>;

const MealSuggestionState = Annotation.Root({
  input: Annotation<MealSuggestionInput>,
  analysis: Annotation<MealAnalysis>,
  plan: Annotation<z.infer<typeof mealPlanSchema>>,
});

const childProfile = (input: MealSuggestionInput) =>
  `こども: 月齢 ${input.ageMonths} か月、性別 ${sexLabel(input.sex)}`;

/**
 * 食事の提案:
 *   analyzeMeals（1 か月分の記録から好み・不足しがちな栄養を分析）
 *   → suggestMeals（分析結果から次の食事を 3 案）
 */
export function buildMealSuggestionGraph(model: AiModel) {
  return new StateGraph(MealSuggestionState)
    .addNode('analyzeMeals', async ({ input }) => ({
      analysis: await model.generate(
        mealAnalysisSchema,
        [
          new SystemMessage(SAFETY_RULES),
          new HumanMessage(
            [
              '次の食事記録（過去 1 か月、自由記述のメモ）から、こどもの食の好みと、よく食べている食材、不足気味かもしれない栄養を分析してください。',
              '記録にない食材を食べていないとは限らないので、不足の判断は控えめにしてください。',
              childProfile(input),
              dataBlock(input.meals),
            ].join('\n\n'),
          ),
        ],
        { name: 'meal_analysis' },
      ),
    }))
    .addNode('suggestMeals', async ({ input, analysis }) => ({
      plan: await model.generate(
        mealPlanSchema,
        [
          new SystemMessage(SAFETY_RULES),
          new HumanMessage(
            [
              '分析結果をもとに、次の食事を 3 案提案してください。',
              '好きそうな食べ物を取り入れつつ、不足気味の栄養を補えるものにしてください。家庭で作りやすい料理にし、月齢に合う固さ・大きさの注意点を添えてください。',
              '初めての食材を含む場合は「少量から試す」ことを注意点に書いてください。',
              childProfile(input),
              dataBlock(analysis),
            ].join('\n\n'),
          ),
        ],
        { name: 'meal_plan' },
      ),
    }))
    .addEdge(START, 'analyzeMeals')
    .addEdge('analyzeMeals', 'suggestMeals')
    .addEdge('suggestMeals', END)
    .compile();
}

export type MealSuggestionGraph = ReturnType<typeof buildMealSuggestionGraph>;

export async function runMealSuggestion(
  graph: MealSuggestionGraph,
  input: MealSuggestionInput,
): Promise<MealSuggestionContent> {
  const { analysis, plan } = await graph.invoke({ input });
  return {
    preferences: analysis.preferences,
    possiblyLacking: analysis.possiblyLacking,
    suggestions: plan.suggestions,
  };
}
