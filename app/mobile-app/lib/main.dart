import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_web_plugins/url_strategy.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'app.dart';
import 'core/api_client.dart';
import 'core/env.dart';
import 'core/providers.dart';
import 'features/auth/auth_repository.dart';
import 'features/auth/session.dart';
import 'core/browser_url.dart';
import 'features/families/pending_invite.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Web の URL を /#/login ではなく /login 形式にする（モバイルでは何もしない）
  usePathUrlStrategy();
  // 招待リンクのコードを読み取ったら、アドレスバー・履歴から消す
  final inviteCode = inviteCodeFromUrl(Uri.base);
  if (inviteCode != null) replaceBrowserUrl('/invite');
  Env.validate();
  await initializeDateFormatting('ja');
  final session = Session();
  try {
    await session.load();
  } catch (_) {
    // キーストア破損などで読めない場合は、ログアウト状態から始める
    await session.clear().catchError((_) {});
  }
  await AuthRepository(
    createBareDio(Env.apiBaseUrl),
    session,
  ).restoreWebSession();

  runApp(
    ProviderScope(
      overrides: [
        sessionProvider.overrideWithValue(session),
        pendingInviteCodeProvider.overrideWith(
          () => PendingInviteCode(inviteCode),
        ),
      ],
      // 失敗時の自動リトライはしない（再読み込みは利用者の操作で行う）
      retry: (_, _) => null,
      child: const CradleApp(),
    ),
  );
}
