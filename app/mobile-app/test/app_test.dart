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

Future<Session> _session({bool loggedIn = false}) async {
  FlutterSecureStorage.setMockInitialValues(
    loggedIn ? {'access_token': 'a', 'refresh_token': 'r'} : {},
  );
  final session = Session();
  await session.load();
  return session;
}

Widget _app(Session session, {List<Child> children = const []}) =>
    ProviderScope(
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
