import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/providers.dart';
import '../../core/refresh_lock.dart';
import 'session.dart';

class AuthRepository {
  AuthRepository(this._dio, this._session);

  final Dio _dio;
  final Session _session;

  Future<void> login({required String email, required String password}) =>
      _authenticate('/auth/login', {'email': email, 'password': password});

  Future<void> signup({
    required String email,
    required String password,
    required String name,
  }) => _authenticate('/auth/signup', {
    'email': email,
    'password': password,
    'name': name,
  });

  /// Web のリロード時に、Cookie のリフレッシュトークンでログイン状態を復元する
  /// 起動は最大 5 秒だけ待つ。通信自体は打ち切らない
  /// （サーバーが更新済みなのに打ち切ると、ブラウザに失効済みの Cookie が残るため）。
  /// 5 秒を過ぎて成功した場合は、その時点でログイン状態になりホームへ移る
  Future<void> restoreWebSession() async {
    if (!kIsWeb) return;
    final restore = withRefreshLock(() async {
      final res = await _dio.post<Map<String, dynamic>>('/auth/refresh');
      await _session.save(Tokens.fromJson(res.data!));
    });
    try {
      await restore.timeout(const Duration(seconds: 5));
    } on TimeoutException {
      restore.ignore();
    } catch (_) {
      // Cookie がない・失効・通信エラーなどはログアウト状態で始める（起動は止めない）
    }
  }

  Future<void> logout() async {
    final refreshToken = _session.tokens?.refreshToken;
    await _session.clear();
    // Web は Cookie の削除もサーバーに依頼する必要があるので常に呼ぶ
    if (refreshToken == null && !kIsWeb) return;
    try {
      // 他タブの更新と重なると、更新後の新しい Cookie が残ってログアウトが取り消されるため排他する
      await withRefreshLock(
        () => _dio.post<void>(
          '/auth/logout',
          data: refreshTokenBody(refreshToken),
        ),
      );
    } on DioException {
      // 端末側のトークンは消えているので、サーバーへの失効通知の失敗は無視する
    }
  }

  /// Web は他タブの更新が、ログイン直後の Cookie を上書きしないよう排他する
  Future<void> _authenticate(String path, Map<String, String> body) =>
      withRefreshLock(() async {
        final res = await _dio.post<Map<String, dynamic>>(path, data: body);
        await _session.save(Tokens.fromJson(res.data!));
      });
}

final authRepositoryProvider = Provider<AuthRepository>(
  (ref) =>
      AuthRepository(ref.watch(authDioProvider), ref.watch(sessionProvider)),
);
