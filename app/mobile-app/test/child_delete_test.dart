import 'package:cradle/app.dart';
import 'package:cradle/core/providers.dart';
import 'package:cradle/features/auth/session.dart';
import 'package:cradle/features/children/child.dart';
import 'package:cradle/features/children/children_providers.dart';
import 'package:cradle/features/records/records_providers.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';

/// 削除の呼び出しを記録し、一覧から取り除く偽のリポジトリ
class _FakeChildrenRepository implements ChildrenRepository {
  _FakeChildrenRepository(this.children, {this.error});

  final List<Child> children;
  final Object? error;
  final deleted = <String>[];

  @override
  Future<void> delete(String id) async {
    if (error case final e?) throw e;
    deleted.add(id);
    children.removeWhere((c) => c.id == id);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Future<Widget> _app(_FakeChildrenRepository repo) async {
  FlutterSecureStorage.setMockInitialValues({
    'access_token': 'a',
    'refresh_token': 'r',
  });
  final session = Session();
  await session.load();
  return ProviderScope(
    overrides: [
      sessionProvider.overrideWithValue(session),
      childrenRepositoryProvider.overrideWithValue(repo),
      childrenProvider.overrideWith((ref) async => List.of(repo.children)),
      dayRecordsProvider.overrideWith((ref, arg) async => const []),
    ],
    retry: (_, _) => null,
    child: const CradleApp(),
  );
}

Child _child(String id, String name, {String familyId = 'f1'}) =>
    Child(id: id, familyId: familyId, name: name, birthDate: DateTime(2025));

void main() {
  setUpAll(() => initializeDateFormatting('ja'));

  Future<void> openEdit(WidgetTester tester) async {
    await tester.tap(find.byIcon(Icons.more_vert));
    await tester.pumpAndSettle();
    await tester.tap(find.text('こどもの情報を編集'));
    await tester.pumpAndSettle();
  }

  Finder deleteButton() => find.widgetWithText(OutlinedButton, 'このこどもを削除');

  testWidgets('deletes a child after confirmation and selects another', (
    tester,
  ) async {
    final repo = _FakeChildrenRepository([
      _child('c1', 'たろう'),
      _child('c2', 'はなこ'),
    ]);
    await tester.pumpWidget(await _app(repo));
    await tester.pumpAndSettle();
    expect(find.text('たろう'), findsOneWidget);
    await openEdit(tester);

    // キャンセルでは削除しない
    await tester.ensureVisible(deleteButton());
    await tester.tap(deleteButton());
    await tester.pumpAndSettle();
    expect(find.text('たろうを削除しますか？'), findsOneWidget);
    await tester.tap(find.text('キャンセル'));
    await tester.pumpAndSettle();
    expect(repo.deleted, isEmpty);

    await tester.tap(deleteButton());
    await tester.pumpAndSettle();
    await tester.tap(find.text('削除する'));
    await tester.pumpAndSettle();
    expect(repo.deleted, ['c1']);

    // ホームに戻り、残ったこどもが選ばれている
    expect(find.text('こどもの情報を編集'), findsNothing);
    expect(find.text('はなこ'), findsOneWidget);
    expect(find.text('たろう'), findsNothing);
  });

  testWidgets('cannot delete the only child in the family', (tester) async {
    final repo = _FakeChildrenRepository([
      _child('c1', 'たろう'),
      // 別の家族のこどもは数えない
      _child('c2', 'はなこ', familyId: 'f2'),
    ]);
    await tester.pumpWidget(await _app(repo));
    await tester.pumpAndSettle();
    await openEdit(tester);

    await tester.ensureVisible(deleteButton());
    expect(tester.widget<OutlinedButton>(deleteButton()).onPressed, isNull);
    expect(find.text('こどもが 1 人だけのときは削除できません'), findsOneWidget);
  });

  testWidgets('shows the server error when the delete is rejected', (
    tester,
  ) async {
    // 別の端末で先に削除されて、最後の 1 人になっていた場合など
    final repo = _FakeChildrenRepository(
      [_child('c1', 'たろう'), _child('c2', 'はなこ')],
      error: DioException(
        requestOptions: RequestOptions(),
        response: Response(
          requestOptions: RequestOptions(),
          statusCode: 409,
          data: {'code': 'LAST_CHILD'},
        ),
      ),
    );
    await tester.pumpWidget(await _app(repo));
    await tester.pumpAndSettle();
    await openEdit(tester);

    await tester.ensureVisible(deleteButton());
    await tester.tap(deleteButton());
    await tester.pumpAndSettle();
    await tester.tap(find.text('削除する'));
    await tester.pumpAndSettle();

    expect(find.text('家族のこどもが 1 人だけのときは削除できません'), findsOneWidget);
    // 編集画面に残る
    expect(find.text('こどもの情報を編集'), findsOneWidget);
  });
}
