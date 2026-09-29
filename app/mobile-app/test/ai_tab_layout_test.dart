import 'package:cradle/features/ai/ai_models.dart';
import 'package:cradle/features/ai/ai_providers.dart';
import 'package:cradle/features/ai/ai_tab.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

WeeklyReport _report({
  List<String> concerns = const [],
  int? weightChangeG,
  int sleepAvgMinutesPerDay = 725,
}) => WeeklyReport(
  id: 'r1',
  periodStart: DateTime(2026, 9, 18, 17),
  periodEnd: DateTime(2026, 9, 25, 17),
  headline: 'ミルクをよく飲み、夜もまとまって眠れた 1 週間でした',
  goodPoints: const ['ミルクをしっかり飲めた'],
  concerns: concerns,
  trends: const ['睡眠が安定'],
  milkAvgMlPerDay: 1200,
  sleepAvgMinutesPerDay: sleepAvgMinutesPerDay,
  mealCount: 21,
  weightChangeG: weightChangeG,
);

class _Repo implements AiRepository {
  _Repo({this.suggestion, this.report});

  final MealSuggestion? suggestion;
  final WeeklyReport? report;

  @override
  Future<MealSuggestionState> latestMealSuggestion(String childId) async =>
      MealSuggestionState(
        suggestion: suggestion,
        remainingToday: 2,
        enabled: true,
      );

  @override
  Future<MealSuggestionState> createMealSuggestion(String childId) =>
      throw UnimplementedError();

  @override
  Future<List<WeeklyReport>> weeklyReports(String childId) async => [?report];

  @override
  Future<bool> weeklyReportEmail() async => true;

  @override
  Future<bool> setWeeklyReportEmail(bool enabled) async => enabled;
}

final _fullSuggestion = MealSuggestion(
  id: 's',
  createdAt: DateTime(2026, 9, 29, 12),
  preferences: const ['かぼちゃなど甘みのある野菜', 'おかゆ'],
  possiblyLacking: const [
    LackingNutrient(nutrient: 'カルシウム', reason: '乳製品や小魚がほとんど見られません。'),
  ],
  suggestions: const [
    MealIdea(
      dish: 'しらすとかぼちゃのおかゆ',
      reason: '好きなかぼちゃでカルシウムを補えます。',
      nutrients: ['ビタミンA', 'たんぱく質'],
      caution: 'しらすは塩抜きしてください。',
    ),
  ],
);

Future<void> _pump(
  WidgetTester tester,
  _Repo repo, {
  Brightness brightness = Brightness.light,
  double width = 400,
  double textScale = 1,
}) async {
  tester.view.physicalSize = Size(width, 4000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [aiRepositoryProvider.overrideWithValue(repo)],
      child: MaterialApp(
        theme: ThemeData(
          colorScheme: ColorScheme.fromSeed(
            seedColor: const Color(0xFFF4A261),
            brightness: brightness,
          ),
        ),
        home: MediaQuery.withClampedTextScaling(
          minScaleFactor: textScale,
          maxScaleFactor: textScale,
          child: const Scaffold(body: AiTab(childId: 'c1')),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

// 読み上げで「注意」と伝わるアイコン
final _cautionIcon = find.byWidgetPredicate(
  (w) => w is Icon && w.semanticLabel == '注意',
);

void main() {
  // 狭い画面・大きな文字・ダークテーマでも、はみ出し（overflow）の例外が出ないこと
  for (final (width, scale, brightness) in [
    (400.0, 1.0, Brightness.dark),
    (320.0, 1.3, Brightness.light),
    (320.0, 2.0, Brightness.dark),
  ]) {
    testWidgets('lays out without overflow (w=$width, x$scale, $brightness)', (
      tester,
    ) async {
      await _pump(
        tester,
        _Repo(
          suggestion: _fullSuggestion,
          report: _report(
            concerns: const ['食事の記録が少なめです'],
            weightChangeG: 150,
            sleepAvgMinutesPerDay: 12 * 60 + 55,
          ),
        ),
        brightness: brightness,
        width: width,
        textScale: scale,
      );
      expect(tester.takeException(), isNull);
      expect(find.text('しらすとかぼちゃのおかゆ'), findsOneWidget);
      expect(find.text('12時間55分'), findsOneWidget);
    });
  }

  testWidgets('shows concerns and a weight decrease', (tester) async {
    await _pump(
      tester,
      _Repo(
        report: _report(concerns: const ['食事の記録が少なめです'], weightChangeG: -80),
      ),
    );
    expect(find.text('気になる点'), findsOneWidget);
    expect(find.text('食事の記録が少なめです'), findsOneWidget);
    expect(find.text('-80 g'), findsOneWidget);
    expect(find.byIcon(Icons.trending_down), findsOneWidget);
  });

  testWidgets('shows three stat tiles when there is no weight', (tester) async {
    await _pump(tester, _Repo(report: _report()));
    expect(find.text('体重の増減'), findsNothing);
    expect(find.text('1日平均のミルク'), findsOneWidget);
    expect(find.text('食事の記録'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('hides empty parts of a suggestion', (tester) async {
    await _pump(
      tester,
      _Repo(
        suggestion: MealSuggestion(
          id: 's',
          createdAt: DateTime(2026, 9, 29, 12),
          preferences: const [],
          possiblyLacking: const [],
          suggestions: const [
            MealIdea(dish: 'おかゆ', reason: '食べやすい', nutrients: [], caution: ''),
          ],
        ),
      ),
    );
    expect(find.text('おかゆ'), findsOneWidget);
    expect(find.text('好みの傾向'), findsNothing);
    expect(find.text('不足気味かもしれない栄養'), findsNothing);
    expect(_cautionIcon, findsNothing);
  });

  testWidgets('places each nutrient under the right heading', (tester) async {
    await _pump(tester, _Repo(suggestion: _fullSuggestion));
    final lacking = find
        .ancestor(
          of: find.text('不足気味かもしれない栄養'),
          matching: find.byType(ClipRRect),
        )
        .first;
    expect(
      find.descendant(of: lacking, matching: find.text('カルシウム')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: lacking, matching: find.text('ビタミンA')),
      findsNothing,
    );
    // 注意事項は読み上げでも「注意」とわかる
    expect(_cautionIcon, findsOneWidget);
  });
}
