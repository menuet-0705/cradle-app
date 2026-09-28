import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'app.dart';
import 'core/env.dart';
import 'core/providers.dart';
import 'features/auth/session.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  Env.validate();
  await initializeDateFormatting('ja');
  final session = Session();
  try {
    await session.load();
  } catch (_) {
    // キーストア破損などで読めない場合は、ログアウト状態から始める
    await session.clear().catchError((_) {});
  }

  runApp(
    ProviderScope(
      overrides: [sessionProvider.overrideWithValue(session)],
      // 失敗時の自動リトライはしない（再読み込みは利用者の操作で行う）
      retry: (_, _) => null,
      child: const CradleApp(),
    ),
  );
}
