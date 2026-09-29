import 'package:cradle/app.dart';
import 'package:cradle/core/providers.dart';
import 'package:cradle/features/auth/session.dart';
import 'package:cradle/features/children/child.dart';
import 'package:cradle/features/children/children_providers.dart';
import 'package:cradle/features/records/growth_record.dart';
import 'package:cradle/features/records/records_providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:intl/intl.dart';

Future<Session> _session({bool loggedIn = false}) async {
  FlutterSecureStorage.setMockInitialValues(
    loggedIn ? {'access_token': 'a', 'refresh_token': 'r'} : {},
  );
  final session = Session();
  await session.load();
  return session;
}

Widget _app(
  Session session, {
  List<Child> children = const [],
  bool withWeight = false,
  bool withMeal = false,
}) => ProviderScope(
  overrides: [
    sessionProvider.overrideWithValue(session),
    childrenProvider.overrideWith((ref) async => children),
    weightSeriesProvider.overrideWith((ref, childId) async => const []),
    milkDailyProvider.overrideWith((ref, childId) async => const []),
    dayRecordsProvider.overrideWith(
      (ref, arg) async => [
        GrowthRecord(
          id: 'r1',
          type: RecordType.milk,
          startedAt: arg.day.add(const Duration(hours: 9)),
          amountMl: 120,
        ),
        if (withWeight)
          GrowthRecord(
            id: 'w1',
            type: RecordType.weight,
            startedAt: arg.day.add(const Duration(hours: 8)),
            weightG: 5250,
            note: '朝',
          ),
        if (withMeal)
          GrowthRecord(
            id: 'f1',
            type: RecordType.meal,
            startedAt: arg.day.add(const Duration(hours: 7)),
            mealSlot: MealSlot.breakfast,
            note: 'パン',
          ),
      ],
    ),
  ],
  retry: (_, _) => null,
  child: const CradleApp(),
);

void main() {
  setUpAll(() => initializeDateFormatting('ja'));

  testWidgets('shows login when logged out, and can go to signup', (
    tester,
  ) async {
    await tester.pumpWidget(_app(await _session()));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(FilledButton, 'ログイン'), findsOneWidget);

    await tester.tap(find.text('はじめての方は新規登録'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(FilledButton, '登録する'), findsOneWidget);
  });

  testWidgets('validates login form before calling the API', (tester) async {
    await tester.pumpWidget(_app(await _session()));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'ログイン'));
    await tester.pump();
    expect(find.text('メールアドレスを入力してください'), findsOneWidget);
  });

  testWidgets('prompts to register a child when there are none', (
    tester,
  ) async {
    await tester.pumpWidget(_app(await _session(loggedIn: true)));
    await tester.pumpAndSettle();
    expect(find.text('まずはこどもを登録しましょう'), findsOneWidget);
  });

  testWidgets('shows the selected child and today\'s records', (tester) async {
    final children = [
      Child(id: 'c1', name: 'たろう', birthDate: DateTime(2026, 4, 1)),
      Child(id: 'c2', name: 'はなこ', birthDate: DateTime(2024, 1, 1)),
    ];
    await tester.pumpWidget(
      _app(await _session(loggedIn: true), children: children),
    );
    await tester.pumpAndSettle();
    expect(find.text('たろう'), findsOneWidget);
    expect(find.text('ミルク  120 ml'), findsOneWidget);

    // こどもの切り替え
    await tester.tap(find.byTooltip('こどもを切り替える'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('はなこ').last);
    await tester.pumpAndSettle();
    expect(find.text('はなこ'), findsOneWidget);
  });

  testWidgets('swipes right for the previous day and left for the next', (
    tester,
  ) async {
    final children = [
      Child(id: 'c1', name: 'たろう', birthDate: DateTime(2026, 4, 1)),
    ];
    await tester.pumpWidget(
      _app(await _session(loggedIn: true), children: children),
    );
    await tester.pumpAndSettle();
    String label(DateTime d) => DateFormat('M月d日(E)', 'ja').format(d);
    final now = today();
    final yesterday = DateTime(now.year, now.month, now.day - 1);
    final list = find.byType(RefreshIndicator);

    await tester.fling(list, const Offset(300, 0), 1000);
    await tester.pumpAndSettle();
    expect(find.text(label(yesterday)), findsOneWidget);

    await tester.fling(list, const Offset(-300, 0), 1000);
    await tester.pumpAndSettle();
    expect(find.text(label(now)), findsOneWidget);

    // 今日より先には進まない
    await tester.fling(list, const Offset(-300, 0), 1000);
    await tester.pumpAndSettle();
    expect(find.text(label(now)), findsOneWidget);

    // ゆっくりしたドラッグでは移動しない
    await tester.timedDrag(
      list,
      const Offset(300, 0),
      const Duration(seconds: 3),
    );
    await tester.pumpAndSettle();
    expect(find.text(label(now)), findsOneWidget);
  });

  testWidgets('weight form overwrites the day\'s recorded weight', (
    tester,
  ) async {
    final children = [
      Child(id: 'c1', name: 'たろう', birthDate: DateTime(2026, 4, 1)),
    ];
    await tester.pumpWidget(
      _app(
        await _session(loggedIn: true),
        children: children,
        withWeight: true,
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('記録を追加'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(ListTile, '体重'));
    await tester.pumpAndSettle();

    expect(find.text('体重を更新'), findsOneWidget);
    expect(find.text('この日の体重は記録済みです。保存すると上書きされます'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, '更新する'), findsOneWidget);
    expect(find.widgetWithText(TextFormField, '5.25'), findsOneWidget);
    expect(find.widgetWithText(TextFormField, '朝'), findsOneWidget);
  });

  testWidgets('groups the day\'s records by type with a summary', (
    tester,
  ) async {
    final children = [
      Child(id: 'c1', name: 'たろう', birthDate: DateTime(2026, 4, 1)),
    ];
    await tester.pumpWidget(
      _app(
        await _session(loggedIn: true),
        children: children,
        withWeight: true,
        withMeal: true,
      ),
    );
    await tester.pumpAndSettle();

    final headers = ['ミルク  1回 · 合計 120 ml', '体重', '食事  1回'];
    for (final h in headers) {
      expect(find.text(h), findsOneWidget);
    }
    // 見出しは種類の順（ミルク → 体重 → 食事）に並ぶ
    final ys = [for (final h in headers) tester.getTopLeft(find.text(h)).dy];
    expect(ys, [...ys]..sort());
    // 食事は区分名で出す
    expect(find.text('朝食  パン'), findsOneWidget);
  });

  testWidgets('meal form overwrites the recorded meal of the slot', (
    tester,
  ) async {
    final children = [
      Child(id: 'c1', name: 'たろう', birthDate: DateTime(2026, 4, 1)),
    ];
    await tester.pumpWidget(
      _app(await _session(loggedIn: true), children: children, withMeal: true),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('記録を追加'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(ListTile, '食事'));
    await tester.pumpAndSettle();

    // 記録済みの区分（朝食）を選ぶと、内容が入り上書きの案内が出る
    await tester.tap(find.widgetWithText(ChoiceChip, '朝食'));
    await tester.pumpAndSettle();
    expect(find.text('この日の朝食は記録済みです。保存すると上書きされます'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, '更新する'), findsOneWidget);
    expect(find.widgetWithText(TextFormField, 'パン'), findsOneWidget);

    // 記録のない区分に変えると、案内が消え入力欄は空になる
    await tester.tap(find.widgetWithText(ChoiceChip, '夕食'));
    await tester.pumpAndSettle();
    expect(find.textContaining('記録済みです'), findsNothing);
    expect(find.widgetWithText(FilledButton, '保存する'), findsOneWidget);
    expect(find.widgetWithText(TextFormField, 'パン'), findsNothing);

    // 手で入力した後は、区分を変えても入力を消さない
    await tester.enterText(find.byType(TextFormField), 'うどん');
    await tester.tap(find.widgetWithText(ChoiceChip, '朝食'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(TextFormField, 'うどん'), findsOneWidget);
    expect(find.text('この日の朝食は記録済みです。保存すると上書きされます'), findsOneWidget);
  });

  testWidgets('keeps the selected tab in the URL without adding history', (
    tester,
  ) async {
    final children = [
      Child(id: 'c1', name: 'たろう', birthDate: DateTime(2026, 4, 1)),
    ];
    // ブラウザへの URL の通知を記録する（replace: true なら履歴に積まない）
    final reported = <Map<Object?, Object?>>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.navigation,
      (call) async {
        if (call.method == 'routeInformationUpdated') {
          reported.add(call.arguments as Map<Object?, Object?>);
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.navigation,
        null,
      ),
    );
    await tester.pumpWidget(
      _app(await _session(loggedIn: true), children: children),
    );
    await tester.pumpAndSettle();
    int selected() =>
        tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex;
    expect(selected(), 0);

    reported.clear();
    await tester.tap(find.text('グラフ'));
    await tester.pumpAndSettle();
    expect(selected(), 1);
    expect(find.byTooltip('記録を追加'), findsNothing);
    expect(reported, isNotEmpty);
    expect(reported.last['uri'], '/?tab=charts');
    expect(reported.last['replace'], isTrue);
  });

  testWidgets('opens the tab in the URL on a fresh start (reload)', (
    tester,
  ) async {
    final children = [
      Child(id: 'c1', name: 'たろう', birthDate: DateTime(2026, 4, 1)),
    ];
    // 再読み込み = その URL からアプリを新しく起動する
    tester.binding.platformDispatcher.defaultRouteNameTestValue =
        '/?tab=charts';
    addTearDown(
      tester.binding.platformDispatcher.clearDefaultRouteNameTestValue,
    );
    await tester.pumpWidget(
      _app(await _session(loggedIn: true), children: children),
    );
    await tester.pumpAndSettle();
    expect(
      tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex,
      1,
    );

    // 不明な値は記録タブ
    await tester.pumpWidget(const SizedBox());
    tester.binding.platformDispatcher.defaultRouteNameTestValue =
        '/?tab=unknown';
    await tester.pumpWidget(
      _app(await _session(loggedIn: true), children: children),
    );
    await tester.pumpAndSettle();
    expect(
      tester.widget<NavigationBar>(find.byType(NavigationBar)).selectedIndex,
      0,
    );
  });

  testWidgets('logging out returns to the login screen', (tester) async {
    await tester.pumpWidget(_app(await _session(loggedIn: true)));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(PopupMenuButton<String>).last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('ログアウト'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(FilledButton, 'ログイン'), findsOneWidget);
  });
}
