import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'core/providers.dart';
import 'features/auth/auth_screens.dart';
import 'features/children/child.dart';
import 'features/children/child_form_screen.dart';
import 'features/families/family_screen.dart';
import 'features/families/invite_screen.dart';
import 'features/families/pending_invite.dart';
import 'features/home/home_screen.dart';
import 'features/records/growth_record.dart';
import 'features/records/record_form_screen.dart';

typedef NewRecordArgs = ({String childId, RecordType type, DateTime day});

const _publicPaths = {'/login', '/signup'};

final routerProvider = Provider<GoRouter>((ref) {
  final session = ref.watch(sessionProvider);
  final router = GoRouter(
    initialLocation: '/',
    refreshListenable: session,
    redirect: (context, state) {
      final isPublic = _publicPaths.contains(state.matchedLocation);
      if (!session.isLoggedIn) return isPublic ? null : '/login';
      if (isPublic) {
        // 招待リンクから来ていれば、ログイン・登録の後に招待の確認画面へ戻す
        return ref.read(pendingInviteCodeProvider) == null ? '/' : '/invite';
      }
      return null;
    },
    routes: [
      GoRoute(path: '/', builder: (_, _) => const HomeScreen()),
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      GoRoute(path: '/signup', builder: (_, _) => const SignupScreen()),
      GoRoute(path: '/family', builder: (_, _) => const FamilyScreen()),
      GoRoute(path: '/invite', builder: (_, _) => const InviteScreen()),
      GoRoute(
        path: '/children/new',
        builder: (_, _) => const ChildFormScreen(),
      ),
      // extra で渡す画面は、復元などで extra が失われたらホームに戻す
      GoRoute(
        path: '/children/edit',
        redirect: (_, state) => state.extra is Child ? null : '/',
        builder: (_, state) => ChildFormScreen(child: state.extra! as Child),
      ),
      GoRoute(
        path: '/records/new',
        redirect: (_, state) => state.extra is NewRecordArgs ? null : '/',
        builder: (_, state) {
          final args = state.extra! as NewRecordArgs;
          return RecordFormScreen(
            childId: args.childId,
            type: args.type,
            initialDay: args.day,
          );
        },
      ),
    ],
  );
  ref.onDispose(router.dispose);
  return router;
});

class CradleApp extends ConsumerWidget {
  const CradleApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp.router(
      title: 'すくすく記録',
      routerConfig: ref.watch(routerProvider),
      theme: _theme(Brightness.light),
      darkTheme: _theme(Brightness.dark),
      locale: const Locale('ja'),
      supportedLocales: const [Locale('ja')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
    );
  }

  ThemeData _theme(Brightness brightness) => ThemeData(
    colorScheme: ColorScheme.fromSeed(
      seedColor: const Color(0xFFF4A261),
      brightness: brightness,
    ),
    inputDecorationTheme: const InputDecorationTheme(
      border: OutlineInputBorder(),
    ),
  );
}
