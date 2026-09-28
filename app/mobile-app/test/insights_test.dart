import 'package:cradle/features/families/families_providers.dart';
import 'package:cradle/features/families/family.dart';
import 'package:cradle/features/insights/insights.dart';
import 'package:cradle/features/insights/insights_providers.dart';
import 'package:cradle/features/insights/insights_tab.dart';
import 'package:cradle/features/insights/weekly_report_screen.dart';
import 'package:cradle/features/records/growth_record.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';

final _suggestionJson = {
  'id': 's1',
  'createdAt': '2026-09-29T01:00:00.000Z',
  'createdBy': {'id': 'u1', 'name': 'ママ'},
  'content': {
    'summary': 'にんじんが好きなようです',
    'suggestions': [
      {
        'title': 'にんじんと鶏ささみのおかゆ',
        'foods': ['にんじん', '鶏ささみ'],
        'reason': '好きなにんじんで、たんぱく質を補う',
        'nutrients': ['たんぱく質'],
        'tips': 'ささみは細かくほぐす',
      },
    ],
    'cautions': ['はじめての食材は少量から'],
  },
};

class FakeInsightsRepository extends InsightsRepository {
  FakeInsightsRepository() : super(Dio());

  int remaining = 3;
  bool hasSuggestion = false;
  bool limitReached = false;
  int suggestCalls = 0;

  @override
  Future<MealSuggestionState> latestSuggestion(String childId) async =>
      MealSuggestionState.fromJson({
        'suggestion': hasSuggestion ? _suggestionJson : null,
        'remainingToday': remaining,
      });

  @override
  Future<MealSuggestionState> suggest(String childId) async {
    suggestCalls++;
    if (limitReached) {
      throw DioException(
        requestOptions: RequestOptions(),
        response: Response(
          requestOptions: RequestOptions(),
          statusCode: 429,
          data: {'code': 'SUGGESTION_LIMIT'},
        ),
      );
    }
    hasSuggestion = true;
    remaining--;
    return latestSuggestion(childId);
  }

  @override
  Future<List<WeeklyReportSummary>> reports(String childId) async => [
    WeeklyReportSummary.fromJson({
      'id': 'r1',
      'periodStart': '2026-09-18T08:00:00.000Z',
      'periodEnd': '2026-09-25T08:00:00.000Z',
      'status': 'READY',
      'headline': 'よく眠れた 1 週間',
    }),
    WeeklyReportSummary.fromJson({
      'id': 'r2',
      'periodStart': '2026-09-25T08:00:00.000Z',
      'periodEnd': '2026-10-02T08:00:00.000Z',
      'status': 'PENDING',
      'headline': null,
    }),
  ];

  @override
  Future<WeeklyReport> report(String childId, String reportId) async =>
      WeeklyReport.fromJson({
        'id': reportId,
        'periodStart': '2026-09-18T08:00:00.000Z',
        'periodEnd': '2026-09-25T08:00:00.000Z',
        'status': 'READY',
        'content': {
          'headline': 'よく眠れた 1 週間',
          'goodPoints': ['夜にまとまって眠れました'],
          'concerns': ['ミルクの量が少し減っています'],
          'trends': [],
          'nextWeekTips': ['お昼寝の時間をそろえましょう'],
          'consultDoctor': true,
          'consultReason': '体重が 2 週続けて減っています',
        },
      });
}

Family _family({bool aiEnabled = true, FamilyRole role = FamilyRole.owner}) =>
    Family(
      id: 'f1',
      name: 'ママの家族',
      myRole: role,
      members: const [],
      aiEnabled: aiEnabled,
    );

class FakeFamiliesRepository extends FamiliesRepository {
  FakeFamiliesRepository() : super(Dio());

  final consents = <bool>[];

  @override
  Future<void> setAiConsent(String familyId, {required bool enabled}) async {
    consents.add(enabled);
  }
}

Widget _wrap(
  Widget child,
  FakeInsightsRepository repo, {
  Family? family,
  FakeFamiliesRepository? families,
}) => ProviderScope(
  overrides: [
    insightsRepositoryProvider.overrideWithValue(repo),
    familiesProvider.overrideWith((ref) async => [family ?? _family()]),
    familiesRepositoryProvider.overrideWithValue(
      families ?? FakeFamiliesRepository(),
    ),
  ],
  retry: (_, _) => null,
  child: MaterialApp(
    locale: const Locale('ja'),
    supportedLocales: const [Locale('ja')],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    home: Scaffold(body: child),
  ),
);

void main() {
  setUpAll(() => initializeDateFormatting('ja'));

  test('meal records send amount and reaction only when chosen', () {
    final at = DateTime.utc(2026, 9, 29, 3);
    expect(
      NewRecord(
        type: RecordType.meal,
        startedAt: at,
        note: 'にんじん',
        mealAmount: MealAmount.all,
        mealReaction: MealReaction.liked,
      ).toJson(),
      containsPair('mealReaction', 'LIKED'),
    );
    expect(
      NewRecord(type: RecordType.meal, startedAt: at, note: 'にんじん').toJson(),
      isNot(contains('mealAmount')),
    );
    final record = GrowthRecord.fromJson({
      'id': 'r',
      'type': 'MEAL',
      'startedAt': '2026-09-29T03:00:00.000Z',
      'note': 'にんじん',
      'mealAmount': 'HALF',
      'mealReaction': 'DISLIKED',
    });
    expect(record.summary, 'にんじん（半分） 苦手');
  });

  testWidgets('asks for a suggestion and shows it with remaining count', (
    tester,
  ) async {
    final repo = FakeInsightsRepository();
    await tester.pumpWidget(
      _wrap(const InsightsTab(childId: 'c1', familyId: 'f1'), repo),
    );
    await tester.pumpAndSettle();
    expect(find.text('提案してもらう（今日あと 3 回）'), findsOneWidget);
    expect(find.textContaining('医療上の助言ではありません'), findsOneWidget);
    // 同意した管理者以外のメンバーにも、AI に送られていることが分かる
    expect(find.textContaining('管理者の同意により AI 機能が有効'), findsOneWidget);

    await tester.tap(find.text('提案してもらう（今日あと 3 回）'));
    await tester.pumpAndSettle();
    expect(repo.suggestCalls, 1);
    expect(find.text('にんじんと鶏ささみのおかゆ'), findsOneWidget);
    expect(find.text('・はじめての食材は少量から'), findsOneWidget);
    expect(find.text('提案してもらう（今日あと 2 回）'), findsOneWidget);

    // 週次レポート: 完成済みは見出し、作成中はその旨
    expect(find.text('よく眠れた 1 週間'), findsOneWidget);
    expect(find.text('作成中です'), findsOneWidget);
  });

  testWidgets('explains the daily limit and disables the button at zero', (
    tester,
  ) async {
    final repo = FakeInsightsRepository()..limitReached = true;
    await tester.pumpWidget(
      _wrap(const InsightsTab(childId: 'c1', familyId: 'f1'), repo),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('提案してもらう（今日あと 3 回）'));
    await tester.pumpAndSettle();
    expect(find.textContaining('今日の提案の上限に達しました'), findsOneWidget);

    final none = FakeInsightsRepository()..remaining = 0;
    await tester.pumpWidget(
      _wrap(const InsightsTab(childId: 'c2', familyId: 'f1'), none),
    );
    await tester.pumpAndSettle();
    final button = tester.widget<ButtonStyleButton>(
      find.ancestor(
        of: find.text('提案してもらう（今日あと 0 回）'),
        matching: find.byWidgetPredicate((w) => w is ButtonStyleButton),
      ),
    );
    expect(button.onPressed, isNull);
  });

  testWidgets('report detail highlights when to consult a doctor', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        const WeeklyReportScreen(childId: 'c1', reportId: 'r1'),
        FakeInsightsRepository(),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('よく眠れた 1 週間'), findsOneWidget);
    expect(find.textContaining('体重が 2 週続けて減っています'), findsOneWidget);
    expect(find.text('・ミルクの量が少し減っています'), findsOneWidget);
    // 空の項目（傾向）は出さない
    expect(find.text('傾向'), findsNothing);
  });

  testWidgets('asks the owner to consent before using AI features', (
    tester,
  ) async {
    final repo = FakeInsightsRepository();
    final families = FakeFamiliesRepository();
    await tester.pumpWidget(
      _wrap(
        const InsightsTab(childId: 'c1', familyId: 'f1'),
        repo,
        family: _family(aiEnabled: false),
        families: families,
      ),
    );
    await tester.pumpAndSettle();
    // 同意前は提案・レポートを取得しない
    expect(find.textContaining('提案してもらう'), findsNothing);
    await tester.tap(find.text('説明を読んで使いはじめる'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Anthropic 社（米国）'), findsOneWidget);
    await tester.tap(find.text('同意して使う'));
    await tester.pumpAndSettle();
    expect(families.consents, [true]);
  });

  testWidgets('members cannot consent', (tester) async {
    await tester.pumpWidget(
      _wrap(
        const InsightsTab(childId: 'c1', familyId: 'f1'),
        FakeInsightsRepository(),
        family: _family(aiEnabled: false, role: FamilyRole.member),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('説明を読んで使いはじめる'), findsNothing);
    expect(find.textContaining('管理者が同意すると使える'), findsOneWidget);
  });
}
