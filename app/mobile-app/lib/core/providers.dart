import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../features/auth/session.dart';
import 'api_client.dart';
import 'env.dart';

/// main() で読み込み済みの Session を override して渡す
final sessionProvider = Provider<Session>(
  (ref) => throw UnimplementedError('sessionProvider must be overridden'),
);

final baseUrlProvider = Provider<String>((ref) => Env.apiBaseUrl);

final dioProvider = Provider<Dio>(
  (ref) =>
      createAuthedDio(ref.watch(baseUrlProvider), ref.watch(sessionProvider)),
);

/// 認証 API 用（トークン不要）
final authDioProvider = Provider<Dio>(
  (ref) => createBareDio(ref.watch(baseUrlProvider)),
);

/// ログイン状態。変わるとこれを watch しているデータ系プロバイダが作り直され、
/// 前のユーザーのデータが残らない
final isLoggedInProvider = Provider<bool>((ref) {
  final session = ref.watch(sessionProvider);
  void listener() => ref.invalidateSelf();
  session.addListener(listener);
  ref.onDispose(() => session.removeListener(listener));
  return session.isLoggedIn;
});
