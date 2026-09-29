import 'package:cradle/features/ai/ai_models.dart';
import 'package:cradle/features/ai/ai_providers.dart';
import 'package:cradle/features/ai/ai_tab.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

MealSuggestion _suggestion(String dish) => MealSuggestion(
  id: dish,
  createdAt: DateTime(2026, 9, 29, 12),
  preferences: const ['かぼちゃが好き'],
  possiblyLacking: const [LackingNutrient(nutrient: '鉄分', reason: '肉が少ない')],
  suggestions: [
    MealIdea(
      dish: dish,
      reason: '鉄分を補える',
      nutrients: const ['鉄分'],
      caution: '小さく',
    ),
  ],
);

class _FakeAiRepository implements AiRepository {
  var state = const MealSuggestionState(
    suggestion: null,
    remainingToday: 3,
    enabled: true,
  );
  var email = true;
  int created = 0;

  @override
  Future<MealSuggestionState> latestMealSuggestion(String childId) async =>
      state;

  @override
  Future<MealSuggestionState> createMealSuggestion(String childId) async {
    created++;
    return state = MealSuggestionState(
      suggestion: _suggestion('まぐろのおかゆ'),
      remainingToday: state.remainingToday - 1,
      enabled: true,
    );
  }

  @override
  Future<List<WeeklyReport>> weeklyReports(String childId) async => [
    WeeklyReport(
      id: 'r1',
      periodStart: DateTime(2026, 9, 18, 17),
      periodEnd: DateTime(2026, 9, 25, 17),
      headline: 'よく飲んだ 1 週間',
      goodPoints: const ['ミルクをしっかり飲めた'],
      concerns: const [],
      trends: const ['睡眠が安定'],
      milkAvgMlPerDay: 600,
      sleepAvgMinutesPerDay: 725,
      mealCount: 3,
      weightChangeG: 150,
    ),
  ];

  @override
  Future<bool> weeklyReportEmail() async => email;

  @override
  Future<bool> setWeeklyReportEmail(bool enabled) async => email = enabled;
}

void main() {
  group('MealSuggestionState', () {
    test('parses the latest suggestion', () {
      final state = MealSuggestionState.fromJson({
        'remainingToday': 2,
        'enabled': true,
        'suggestion': {
          'id': 's1',
          'model': 'google:gemini-3.8-flash',
          'createdAt': '2026-09-29T03:00:00.000Z',
          'content': {
            'preferences': ['かぼちゃが好き'],
            'possiblyLacking': [
              {'nutrient': '鉄分', 'reason': '肉・魚が少ない'},
            ],
            'suggestions': [
              {
                'dish': 'まぐろのおかゆ',
                'reason': '鉄分を補える',
                'nutrients': ['鉄分', 'たんぱく質'],
                'caution': '小さくほぐす',
              },
            ],
          },
        },
      });
      expect(state.remainingToday, 2);
      final s = state.suggestion!;
      expect(s.preferences, ['かぼちゃが好き']);
      expect(s.possiblyLacking.single.nutrient, '鉄分');
      expect(s.suggestions.single.nutrients, ['鉄分', 'たんぱく質']);
      expect(s.suggestions.single.caution, '小さくほぐす');
    });

    test('allows no suggestion yet', () {
      final state = MealSuggestionState.fromJson({
        'suggestion': null,
        'remainingToday': 3,
        'enabled': false,
      });
      expect(state.suggestion, isNull);
      expect(state.enabled, isFalse);
    });
  });

  test('WeeklyReport parses content and summary', () {
    final report = WeeklyReport.fromJson({
      'id': 'r1',
      'periodStart': '2026-09-18T08:00:00.000Z',
      'periodEnd': '2026-09-25T08:00:00.000Z',
      'createdAt': '2026-09-25T08:00:05.000Z',
      'content': {
        'headline': 'よく飲んだ 1 週間',
        'goodPoints': ['ミルクをしっかり飲めた'],
        'concerns': <String>[],
        'trends': ['睡眠が安定'],
      },
      'summary': {
        'recordCount': 10,
        'days': <Object>[],
        'milk': {'totalMl': 4200, 'count': 35, 'avgMlPerDay': 600},
        'sleep': {'totalMinutes': 5040, 'avgMinutesPerDay': 720},
        'meals': {'count': 0},
        'weight': {'firstG': 6000, 'lastG': 6150, 'changeG': 150},
      },
    });
    expect(report.headline, 'よく飲んだ 1 週間');
    expect(report.concerns, isEmpty);
    expect(report.milkAvgMlPerDay, 600);
    expect(report.sleepAvgMinutesPerDay, 720);
    expect(report.weightChangeG, 150);
  });

  group('aiErrorMessage', () {
    DioException err(int status, [Map<String, dynamic>? data]) {
      final req = RequestOptions(path: '/');
      return DioException(
        requestOptions: req,
        response: Response(requestOptions: req, statusCode: status, data: data),
      );
    }

    test('explains AI-specific errors', () {
      expect(
        aiErrorMessage(err(429, {'code': 'DAILY_LIMIT'})),
        contains('回数を使い切りました'),
      );
      expect(
        aiErrorMessage(err(422, {'code': 'NO_MEAL_RECORDS'})),
        contains('食事を記録すると'),
      );
      expect(aiErrorMessage(err(503)), contains('利用できません'));
      // IP 単位の制限（code なし）は共通の文言
      expect(aiErrorMessage(err(429)), contains('試行回数が多すぎます'));
    });
  });

  testWidgets('AiTab generates a suggestion and shows reports and settings', (
    tester,
  ) async {
    final repo = _FakeAiRepository();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [aiRepositoryProvider.overrideWithValue(repo)],
        child: const MaterialApp(
          home: Scaffold(body: AiTab(childId: 'c1')),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('AI による参考情報'), findsOneWidget);
    expect(find.text('今日はあと 3 回提案できます'), findsOneWidget);
    // 最新のレポートは開いた状態で表示する
    expect(find.text('よく飲んだ 1 週間'), findsOneWidget);
    expect(find.text('よかった点'), findsOneWidget);
    expect(find.text('ミルクをしっかり飲めた'), findsOneWidget);
    expect(find.text('傾向'), findsOneWidget);
    expect(find.text('睡眠が安定'), findsOneWidget);
    // 気になる点がない週は囲みごと出さない
    expect(find.text('気になる点'), findsNothing);
    // 集計は数値とラベルのタイル
    expect(find.text('600 ml'), findsOneWidget);
    expect(find.text('12時間5分'), findsOneWidget);
    expect(find.text('1日平均の睡眠'), findsOneWidget);
    expect(find.text('+150 g'), findsOneWidget);
    expect(find.text('体重の増減'), findsOneWidget);

    await tester.tap(find.text('提案してもらう'));
    await tester.pumpAndSettle();
    expect(repo.created, 1);
    expect(find.text('まぐろのおかゆ'), findsOneWidget);
    // 好み・不足しがちな栄養・提案の栄養はタグ、理由は本文として分けて出す
    expect(find.text('かぼちゃが好き'), findsOneWidget);
    expect(find.text('不足気味かもしれない栄養'), findsOneWidget);
    expect(find.text('鉄分'), findsNWidgets(2));
    expect(find.text('肉が少ない'), findsOneWidget);
    expect(find.text('鉄分を補える'), findsOneWidget);
    expect(find.text('小さく'), findsOneWidget);
    expect(find.text('今日はあと 2 回提案できます'), findsOneWidget);

    await tester.scrollUntilVisible(find.byType(SwitchListTile), 200);
    await tester.tap(find.byType(SwitchListTile));
    await tester.pumpAndSettle();
    expect(repo.email, isFalse);
  });
}
