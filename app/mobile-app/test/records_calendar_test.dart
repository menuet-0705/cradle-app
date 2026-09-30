import 'dart:async';

import 'package:cradle/app.dart';
import 'package:cradle/features/auth/session.dart';
import 'package:cradle/features/children/child.dart';
import 'package:cradle/features/children/children_providers.dart';
import 'package:cradle/core/providers.dart';
import 'package:cradle/features/records/daily_summary.dart';
import 'package:cradle/features/records/growth_record.dart';
import 'package:cradle/features/records/records_providers.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:intl/intl.dart';

/// カレンダーの取得だけを差し替える偽のリポジトリ
class _FakeRecordsRepository implements RecordsRepository {
  /// 取得した月（from の日付）
  final requested = <DateTime>[];

  /// 設定すると、完了させるまで読み込み中のままにする
  Completer<List<DailySummary>>? pending;
  Object? error;
  List<DailySummary> Function(DateTime from) data = (_) => const [];
  final deleted = <String>[];

  @override
  Future<void> delete(String recordId) async => deleted.add(recordId);

  @override
  Future<List<DailySummary>> dailySummary(
    String childId, {
    required DateTime from,
    required DateTime to,
    CancelToken? cancelToken,
  }) {
    requested.add(from);
    if (pending case final c?) return c.future;
    if (error case final e?) return Future.error(e);
    return Future.value(data(from));
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Future<Widget> _app(
  _FakeRecordsRepository repo, {
  List<GrowthRecord> dayRecords = const [],
}) async {
  FlutterSecureStorage.setMockInitialValues({
    'access_token': 'a',
    'refresh_token': 'r',
  });
  final session = Session();
  await session.load();
  return ProviderScope(
    overrides: [
      sessionProvider.overrideWithValue(session),
      recordsRepositoryProvider.overrideWithValue(repo),
      childrenProvider.overrideWith(
        (ref) async => [
          Child(id: 'c1', name: 'たろう', birthDate: DateTime(2024, 1, 1)),
        ],
      ),
      dayRecordsProvider.overrideWith((ref, arg) async => dayRecords),
    ],
    retry: (_, _) => null,
    child: const CradleApp(),
  );
}

void main() {
  setUpAll(() => initializeDateFormatting('ja'));

  final now = today();
  final thisMonth = DateTime(now.year, now.month);
  final lastMonth = DateTime(now.year, now.month - 1);
  String monthLabel(DateTime m) => DateFormat('y年M月', 'ja').format(m);

  // 1 日（今日以前の日）の要約
  List<DailySummary> firstDay(DateTime from) => [
    DailySummary(
      date: DateTime(from.year, from.month, 1),
      milkMl: 720,
      milkCount: 2,
      sleepMinutes: 690,
      sleepCount: 3,
      weightG: 7250,
      mealCount: 3,
    ),
  ];

  Future<void> openCalendar(WidgetTester tester) async {
    await tester.tap(find.byTooltip('カレンダーで見る'));
  }

  IconButton button(WidgetTester tester, String tooltip) =>
      tester.widget<IconButton>(
        find.ancestor(
          of: find.byTooltip(tooltip),
          matching: find.byType(IconButton),
        ),
      );

  testWidgets('shows the grid right away with loading placeholders', (
    tester,
  ) async {
    final repo = _FakeRecordsRepository()
      ..pending = Completer<List<DailySummary>>();
    await tester.pumpWidget(await _app(repo));
    await tester.pumpAndSettle();

    await openCalendar(tester);
    // 読み込み中はアニメーションが続くので pumpAndSettle は使わない（画面の切り替えを待つ）
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    // データを待たずに、月の見出しと日付のマスが出ている
    expect(find.text(monthLabel(thisMonth)), findsOneWidget);
    expect(find.text('1'), findsOneWidget);
    expect(find.text('${now.day}'), findsOneWidget);
    // 読み込み中だとわかる表示（進捗バー・まとめ欄の文言）
    expect(find.byType(LinearProgressIndicator), findsOneWidget);
    expect(find.text('読み込み中…'), findsOneWidget);
    expect(find.text('720ml'), findsNothing);

    repo.pending!.complete(firstDay(thisMonth));
    await tester.pumpAndSettle();
    expect(find.byType(LinearProgressIndicator), findsNothing);
    expect(find.text('読み込み中…'), findsNothing);
    expect(find.text('720ml'), findsOneWidget);
    expect(find.text('11.5h'), findsOneWidget);
    expect(find.text('7.25kg'), findsOneWidget);
    expect(find.text('3回'), findsOneWidget);
    // 月のまとめ
    expect(find.text('1日平均 720 ml'), findsOneWidget);
    expect(find.text('1日平均 11時間30分'), findsOneWidget);
  });

  testWidgets('moves between months but not past this month', (tester) async {
    final repo = _FakeRecordsRepository()..data = firstDay;
    await tester.pumpWidget(await _app(repo));
    await tester.pumpAndSettle();
    await openCalendar(tester);
    await tester.pumpAndSettle();

    expect(find.text(monthLabel(thisMonth)), findsOneWidget);
    expect(button(tester, '次の月').onPressed, isNull);

    await tester.tap(find.byTooltip('前の月'));
    await tester.pumpAndSettle();
    expect(find.text(monthLabel(lastMonth)), findsOneWidget);
    expect(repo.requested, contains(lastMonth));
    expect(button(tester, '次の月').onPressed, isNotNull);

    // 取得済みの月に戻ったときは取り直さない
    final count = repo.requested.length;
    await tester.tap(find.byTooltip('次の月'));
    await tester.pumpAndSettle();
    expect(find.text(monthLabel(thisMonth)), findsOneWidget);
    expect(repo.requested.length, count);
  });

  testWidgets('shows an error and retries', (tester) async {
    final repo = _FakeRecordsRepository()..error = Exception('offline');
    await tester.pumpWidget(await _app(repo));
    await tester.pumpAndSettle();
    await openCalendar(tester);
    await tester.pumpAndSettle();

    expect(find.text('エラーが発生しました'), findsOneWidget);
    await tester.dragUntilVisible(
      find.text('読み込めませんでした'),
      find.byType(ListView),
      const Offset(0, -200),
    );
    // マスの枠は出したまま
    expect(find.text('1'), findsOneWidget);

    // 取り直している間は「読み込み中」だけを出す（失敗の文言は消す）
    repo
      ..error = null
      ..pending = Completer<List<DailySummary>>();
    await tester.ensureVisible(find.text('再読み込み'));
    await tester.tap(find.text('再読み込み'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byType(LinearProgressIndicator), findsOneWidget);
    // 下にスクロールしていても、進捗バーは月の見出しのすぐ下（リストの外）に見えている
    expect(
      tester.getRect(find.byType(LinearProgressIndicator)).bottom,
      lessThanOrEqualTo(tester.getRect(find.byType(ListView)).top),
    );
    expect(find.byType(LinearProgressIndicator).hitTestable(), findsOneWidget);
    expect(find.text('読み込めませんでした'), findsNothing);
    expect(find.text('読み込み中…'), findsWidgets);

    repo.pending!.complete(firstDay(thisMonth));
    await tester.pumpAndSettle();
    expect(find.text('エラーが発生しました'), findsNothing);
    expect(find.text('720ml'), findsOneWidget);
  });

  testWidgets('opens the selected day in the records tab', (tester) async {
    final repo = _FakeRecordsRepository()..data = firstDay;
    await tester.pumpWidget(await _app(repo));
    await tester.pumpAndSettle();
    await openCalendar(tester);
    await tester.pumpAndSettle();

    // 先月の 1 日を選ぶ（今日がいつでも過去の日になる）
    await tester.tap(find.byTooltip('前の月'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('1'));
    await tester.pumpAndSettle();
    expect(find.text('2回 · 合計 720 ml'), findsOneWidget);

    await tester.ensureVisible(find.text('この日の記録を見る'));
    await tester.tap(find.text('この日の記録を見る'));
    await tester.pumpAndSettle();

    // 記録画面に戻り、その日のページが出ている
    expect(find.text('カレンダー'), findsNothing);
    expect(
      find.text(DateFormat('M月d日(E)', 'ja').format(lastMonth)),
      findsOneWidget,
    );
    expect(button(tester, '次の日').onPressed, isNotNull);
  });

  testWidgets('fits four lines in a cell with large text', (tester) async {
    // 文字を 1.5 倍に拡大（マスでは 1.2 倍までに抑える）。狭い画面では要約の行が幅に合わせて
    // 縮むので、縮まずに縦に積まれる広い画面（タブレット・Web）で確かめる
    tester.view
      ..physicalSize = const Size(1600, 2400)
      ..devicePixelRatio = 2;
    tester.platformDispatcher.textScaleFactorTestValue = 1.5;
    addTearDown(tester.view.reset);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

    final repo = _FakeRecordsRepository()..data = firstDay;
    await tester.pumpWidget(await _app(repo));
    await tester.pumpAndSettle();
    await openCalendar(tester);
    await tester.pumpAndSettle();

    // はみ出すとレイアウトのエラーでテストが失敗する
    expect(find.text('720ml'), findsOneWidget);
    expect(find.text('3回'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('says the day could not be loaded when the month failed', (
    tester,
  ) async {
    final repo = _FakeRecordsRepository()..error = Exception('offline');
    await tester.pumpWidget(await _app(repo));
    await tester.pumpAndSettle();
    await openCalendar(tester);
    await tester.pumpAndSettle();

    await tester.tap(find.text('1'));
    await tester.pumpAndSettle();
    expect(find.text('この日の記録を見る'), findsOneWidget);
    // 読み込み中のままにしない
    expect(find.text('読み込み中…'), findsNothing);
    expect(find.text('読み込めませんでした'), findsWidgets);
  });

  testWidgets('reloads the month after a record is deleted', (tester) async {
    final repo = _FakeRecordsRepository()..data = firstDay;
    await tester.pumpWidget(
      await _app(
        repo,
        dayRecords: [
          GrowthRecord(
            id: 'r1',
            type: RecordType.milk,
            startedAt: now,
            amountMl: 120,
          ),
        ],
      ),
    );
    await tester.pumpAndSettle();
    await openCalendar(tester);
    await tester.pumpAndSettle();
    expect(repo.requested, [thisMonth]);

    // 記録画面に戻り、記録を削除する
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('削除'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, '削除'));
    await tester.pumpAndSettle();
    expect(repo.deleted, ['r1']);

    // 残しておいた月は捨てられ、開き直すと取り直す
    await openCalendar(tester);
    await tester.pumpAndSettle();
    expect(repo.requested, [thisMonth, thisMonth]);
  });
}
