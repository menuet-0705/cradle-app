import 'package:cradle/features/ai/ai_models.dart';
import 'package:cradle/features/ai/ai_providers.dart';
import 'package:cradle/features/charts/charts_tab.dart';
import 'package:cradle/features/records/records_providers.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

ChartCommentState _state({
  ChartComment? comment,
  bool needsUpdate = false,
  bool generating = false,
  bool limitReached = false,
  bool retryLater = false,
}) => ChartCommentState(
  comment: comment,
  needsUpdate: needsUpdate,
  generating: generating,
  limitReached: limitReached,
  retryLater: retryLater,
  enabled: true,
);

final _comment = ChartComment(
  createdAt: DateTime(2026, 9, 30, 8, 5),
  headline: '順調に増えています',
  points: const ['1 週間で 150 g 増えています', '記録の間隔も安定しています'],
  advice: 'この調子で記録を続けましょう',
);

/// グラフのコメントの取得・作成を記録する偽のリポジトリ
class _FakeAi implements AiRepository {
  _FakeAi(this.states, {this.createError});

  final Map<ChartKind, ChartCommentState> states;
  final Object? createError;
  final gets = <ChartKind>[];
  final creates = <ChartKind>[];

  @override
  Future<ChartCommentState> chartComment(
    String childId,
    ChartKind chart,
  ) async {
    gets.add(chart);
    return states[chart]!;
  }

  @override
  Future<ChartCommentState> createChartComment(
    String childId,
    ChartKind chart,
  ) async {
    creates.add(chart);
    if (createError case final e?) throw e;
    return states[chart] = _state(comment: _comment);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Future<void> _pump(
  WidgetTester tester,
  _FakeAi ai, {
  bool settle = true,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        aiRepositoryProvider.overrideWithValue(ai),
        weightSeriesProvider.overrideWith(
          (ref, childId) async => [
            WeightPoint(DateTime(2026, 9, 23), 6000),
            WeightPoint(DateTime(2026, 9, 30), 6150),
          ],
        ),
        milkDailyProvider.overrideWith(
          (ref, childId) async => [MilkDaily(DateTime(2026, 9, 30), 600, 5)],
        ),
      ],
      retry: (_, _) => null,
      child: const MaterialApp(
        home: Scaffold(body: ChartsTab(childId: 'c1')),
      ),
    ),
  );
  // 作成中はくるくるが回り続けるので、そのときは決まった回数だけ進める
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump();
    await tester.pump();
  }
}

void main() {
  testWidgets('switches charts with tabs', (tester) async {
    final ai = _FakeAi({ChartKind.weight: _state(), ChartKind.milk: _state()});
    await _pump(tester, ai);
    expect(find.text('体重の推移'), findsOneWidget);
    expect(find.text('今日の体重を記録すると、AI のコメントが表示されます'), findsOneWidget);

    await tester.tap(find.text('ミルク'));
    await tester.pumpAndSettle();
    expect(find.text('ミルクの量（直近14日）'), findsOneWidget);
    expect(find.text('今日のミルクを記録すると、AI のコメントが表示されます'), findsOneWidget);
    // 今日の記録がない・データが同じなら作らない
    expect(ai.creates, isEmpty);
  });

  testWidgets('creates a comment automatically when the server asks', (
    tester,
  ) async {
    final ai = _FakeAi({
      ChartKind.weight: _state(needsUpdate: true),
      ChartKind.milk: _state(),
    });
    await _pump(tester, ai);
    expect(ai.creates, [ChartKind.weight]);
    expect(find.text('順調に増えています'), findsOneWidget);
    expect(find.text('1 週間で 150 g 増えています'), findsOneWidget);
    expect(find.text('この調子で記録を続けましょう'), findsOneWidget);
    expect(find.text('9/30 08:05'), findsOneWidget);
  });

  testWidgets('shows the limit and does not retry', (tester) async {
    final req = RequestOptions(path: '/');
    final ai = _FakeAi(
      {
        ChartKind.weight: _state(needsUpdate: true, comment: _comment),
        ChartKind.milk: _state(),
      },
      createError: DioException(
        requestOptions: req,
        response: Response(
          requestOptions: req,
          statusCode: 429,
          data: {'code': 'DAILY_LIMIT'},
        ),
      ),
    );
    await _pump(tester, ai);
    expect(find.text('今日のコメントの更新回数を使い切りました。また明日お試しください'), findsOneWidget);
    // 前のコメントは出したまま。失敗しても同じ画面では送り直さない
    expect(find.text('順調に増えています'), findsOneWidget);
    expect(ai.creates, hasLength(1));
  });

  testWidgets('tells when today\'s comment could not be made', (tester) async {
    final ai = _FakeAi({
      ChartKind.weight: _state(limitReached: true, comment: _comment),
      ChartKind.milk: _state(limitReached: true),
    });
    await _pump(tester, ai);
    expect(find.text('今日はコメントを作れませんでした。明日また表示されます'), findsOneWidget);
    // 前のコメントは出しておく
    expect(find.text('順調に増えています'), findsOneWidget);
    expect(ai.creates, isEmpty);

    await tester.tap(find.text('ミルク'));
    await tester.pumpAndSettle();
    expect(find.text('今日はコメントを作れませんでした。明日また表示されます'), findsOneWidget);
    expect(find.textContaining('記録すると'), findsNothing);
  });

  testWidgets('asks to reopen later right after a failure', (tester) async {
    final ai = _FakeAi({
      ChartKind.weight: _state(retryLater: true),
      ChartKind.milk: _state(),
    });
    await _pump(tester, ai);
    expect(find.text('コメントを作れませんでした。少し時間をおいて開き直してください'), findsOneWidget);
    // 今日の記録はあるので「記録すると表示されます」は出さない
    expect(find.textContaining('記録すると'), findsNothing);
    expect(ai.creates, isEmpty);
  });

  testWidgets('waits while a family member is creating the comment', (
    tester,
  ) async {
    final ai = _FakeAi({
      ChartKind.weight: _state(generating: true),
      ChartKind.milk: _state(),
    });
    await _pump(tester, ai, settle: false);
    expect(find.text('AI がコメントを考えています…'), findsOneWidget);
    expect(ai.creates, isEmpty);

    // できあがったら、次の確認で表示される
    ai.states[ChartKind.weight] = _state(comment: _comment);
    final before = ai.gets.length;
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    expect(ai.gets.length, greaterThan(before));
    expect(find.text('順調に増えています'), findsOneWidget);
    expect(find.text('AI がコメントを考えています…'), findsNothing);
  });
}
