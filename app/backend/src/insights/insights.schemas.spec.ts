import { clampMealSuggestion, clampWeeklyReport } from './insights.schemas.js';

describe('clamp', () => {
  it('trims long text and extra items', () => {
    const long = 'あ'.repeat(1000);
    const meal = clampMealSuggestion({
      summary: long,
      suggestions: Array.from({ length: 5 }, () => ({
        title: long,
        foods: Array.from({ length: 20 }, () => 'にんじん'),
        reason: long,
        nutrients: ['鉄分', ' ', 'ビタミンC'],
        tips: long,
      })),
      cautions: [],
    });
    expect(meal.summary).toHaveLength(400);
    expect(meal.summary.endsWith('…')).toBe(true);
    expect(meal.suggestions).toHaveLength(3);
    expect(meal.suggestions[0].foods).toHaveLength(8);
    expect(meal.suggestions[0].nutrients).toEqual(['鉄分', 'ビタミンC']);

    const report = clampWeeklyReport({
      headline: 'よく眠れた週',
      goodPoints: ['a'],
      concerns: [],
      trends: [],
      nextWeekTips: [],
      consultDoctor: false,
      consultReason: '不要な理由',
    });
    // 相談不要なら理由は空にする
    expect(report.consultReason).toBe('');
  });
});
