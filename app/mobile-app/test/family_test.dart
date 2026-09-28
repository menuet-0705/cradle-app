import 'package:cradle/app.dart';
import 'package:cradle/core/providers.dart';
import 'package:cradle/features/auth/session.dart';
import 'package:cradle/features/children/child.dart';
import 'package:cradle/features/children/children_providers.dart';
import 'package:cradle/features/families/families_providers.dart';
import 'package:cradle/features/families/family.dart';
import 'package:cradle/features/families/pending_invite.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';

/// API を呼ばずに記録だけ取る
class FakeFamiliesRepository extends FamiliesRepository {
  FakeFamiliesRepository() : super(Dio());

  final calls = <String>[];
  bool rejectCode = false;

  @override
  Future<InvitePreview> preview(String code) async {
    calls.add('preview:$code');
    if (rejectCode) {
      throw DioException(
        requestOptions: RequestOptions(),
        response: Response(requestOptions: RequestOptions(), statusCode: 404),
      );
    }
    return InvitePreview(
      familyName: 'ママの家族',
      inviterName: 'ママ',
      expiresAt: DateTime(2026, 10, 1, 12),
    );
  }

  @override
  Future<String> accept(String code) async {
    calls.add('accept:$code');
    return 'f1';
  }

  @override
  Future<void> invite(String familyId, String email) async {
    calls.add('invite:$familyId:$email');
  }

  @override
  Future<void> removeMember(String familyId, String userId) async {
    calls.add('remove:$familyId:$userId');
  }
}

Future<Session> _session({bool loggedIn = false}) async {
  FlutterSecureStorage.setMockInitialValues(
    loggedIn ? {'access_token': 'a', 'refresh_token': 'r'} : {},
  );
  final session = Session();
  await session.load();
  return session;
}

Family _family({required FamilyRole myRole}) => Family(
  id: 'f1',
  name: 'ママの家族',
  myRole: myRole,
  members: const [
    FamilyMember(userId: 'u-mama', name: 'ママ', role: FamilyRole.owner),
    FamilyMember(userId: 'u-papa', name: 'パパ', role: FamilyRole.member),
  ],
);

Future<(ProviderContainer, FakeFamiliesRepository)> _pump(
  WidgetTester tester, {
  required Session session,
  String location = '/',
  String myId = 'u-mama',
  FamilyRole myRole = FamilyRole.owner,
  String? pendingInvite,
}) async {
  final repo = FakeFamiliesRepository();
  final container = ProviderContainer(
    overrides: [
      sessionProvider.overrideWithValue(session),
      pendingInviteCodeProvider.overrideWith(
        () => PendingInviteCode(pendingInvite),
      ),
      familiesRepositoryProvider.overrideWithValue(repo),
      familiesProvider.overrideWith((ref) async => [_family(myRole: myRole)]),
      familyInvitesProvider.overrideWith(
        (ref, familyId) async => [
          PendingInvite(
            id: 'i1',
            email: 'grandma@example.com',
            expiresAt: DateTime(2026, 10, 1, 12),
          ),
        ],
      ),
      myUserIdProvider.overrideWith((ref) async => myId),
      childrenProvider.overrideWith(
        (ref) async => [
          Child(
            id: 'c1',
            familyId: 'f1',
            name: 'たろう',
            birthDate: DateTime(2026, 6, 10),
          ),
        ],
      ),
    ],
    retry: (_, _) => null,
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(container: container, child: const CradleApp()),
  );
  container.read(routerProvider).go(location);
  await tester.pumpAndSettle();
  return (container, repo);
}

void main() {
  setUpAll(() => initializeDateFormatting('ja'));

  test('reads the invite code only from /invite#<code>', () {
    expect(
      inviteCodeFromUrl(Uri.parse('https://x.example/invite#K7QM-4XP2-HN')),
      'K7QM-4XP2-HN',
    );
    expect(inviteCodeFromUrl(Uri.parse('https://x.example/invite')), isNull);
    expect(
      inviteCodeFromUrl(Uri.parse('https://x.example/invite#%3Cscript%3E')),
      isNull,
    );
    expect(inviteCodeFromUrl(Uri.parse('https://x.example/login#ABC')), isNull);
    // 壊れたエスケープでも例外にしない
    expect(
      inviteCodeFromUrl(Uri.parse('https://x.example/invite#%zz')),
      isNull,
    );
    expect(inviteCodeFromUrl(Uri.parse('https://x.example/invite#%')), isNull);
  });

  testWidgets('an invite link keeps the code through login and signup', (
    tester,
  ) async {
    final (container, _) = await _pump(
      tester,
      session: await _session(),
      location: '/invite',
      pendingInvite: 'K7QM-4XP2-HN',
    );
    final router = container.read(routerProvider);
    // コードは URL に出さない
    expect(router.routeInformationProvider.value.uri.toString(), '/login');
    expect(find.textContaining('家族への招待が届いています'), findsOneWidget);

    await tester.tap(find.text('はじめての方は新規登録'));
    await tester.pumpAndSettle();
    expect(router.routeInformationProvider.value.uri.toString(), '/signup');
    expect(find.textContaining('家族への招待が届いています'), findsOneWidget);
  });

  testWidgets('after login, the invite code leads to the invite screen', (
    tester,
  ) async {
    final session = await _session();
    final (container, repo) = await _pump(
      tester,
      session: session,
      location: '/invite',
      pendingInvite: 'K7QM4XP2HN',
    );
    await session.save(const Tokens(accessToken: 'a', refreshToken: 'r'));
    await tester.pumpAndSettle();

    final router = container.read(routerProvider);
    expect(router.routeInformationProvider.value.uri.path, '/invite');
    // 開いた時点で確認が行われる
    expect(repo.calls, ['preview:K7QM4XP2HN']);
    expect(find.text('ママさんからの招待です'), findsOneWidget);
    expect(find.textContaining('その家族は削除され'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, '参加する'));
    await tester.pumpAndSettle();
    expect(repo.calls.last, 'accept:K7QM4XP2HN');
    expect(router.routeInformationProvider.value.uri.path, '/');
    // 参加後は保留中のコードを消す（次にログインしても招待画面に戻らない）
    expect(container.read(pendingInviteCodeProvider), isNull);
  });

  testWidgets('offers to switch accounts when the invite cannot be used', (
    tester,
  ) async {
    final (container, repo) = await _pump(
      tester,
      session: await _session(loggedIn: true),
    );
    repo.rejectCode = true;
    container.read(routerProvider).push('/invite');
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'AAAA-BBBB-CC');
    await tester.tap(find.widgetWithText(FilledButton, '確認する'));
    await tester.pumpAndSettle();
    expect(find.textContaining('この招待は使えません'), findsOneWidget);

    await tester.tap(find.text('別のアカウントでログインする'));
    await tester.pumpAndSettle();
    expect(
      container.read(routerProvider).routeInformationProvider.value.uri.path,
      '/login',
    );
    expect(container.read(pendingInviteCodeProvider), 'AAAA-BBBB-CC');
    expect(find.textContaining('家族への招待が届いています'), findsOneWidget);
  });

  testWidgets('leaving the invite screen without joining forgets the code', (
    tester,
  ) async {
    final (container, _) = await _pump(
      tester,
      session: await _session(loggedIn: true),
      pendingInvite: 'K7QM4XP2HN',
    );
    container.read(routerProvider).push('/invite');
    await tester.pumpAndSettle();
    expect(find.text('ママさんからの招待です'), findsOneWidget);

    container.read(routerProvider).pop();
    await tester.pumpAndSettle();
    expect(container.read(pendingInviteCodeProvider), isNull);
  });

  testWidgets('owner sees members, invites, and can remove a member', (
    tester,
  ) async {
    final (_, repo) = await _pump(
      tester,
      session: await _session(loggedIn: true),
      location: '/family',
    );
    expect(find.text('ママ（あなた）'), findsOneWidget);
    expect(find.text('grandma@example.com'), findsOneWidget);
    // 管理者は自分では抜けられない
    expect(find.text('抜ける'), findsNothing);

    await tester.tap(find.byTooltip('家族から外す'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('外す'));
    await tester.pumpAndSettle();
    expect(repo.calls, ['remove:f1:u-papa']);

    await tester.tap(find.text('メールで招待'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextFormField), 'Grandpa@Example.com');
    await tester.tap(find.text('送信'));
    await tester.pumpAndSettle();
    expect(repo.calls.last, 'invite:f1:grandpa@example.com');
    expect(find.textContaining('招待メールを送信しました'), findsOneWidget);
  });

  testWidgets('a member can leave but cannot remove others', (tester) async {
    final (_, repo) = await _pump(
      tester,
      session: await _session(loggedIn: true),
      location: '/family',
      myId: 'u-papa',
      myRole: FamilyRole.member,
    );
    expect(find.byTooltip('家族から外す'), findsNothing);
    await tester.tap(find.text('抜ける'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(TextButton, '抜ける').last);
    await tester.pumpAndSettle();
    expect(repo.calls, ['remove:f1:u-papa']);
  });
}
