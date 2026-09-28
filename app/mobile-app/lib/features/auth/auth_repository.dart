import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
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

  Future<void> logout() async {
    final refreshToken = _session.tokens?.refreshToken;
    await _session.clear();
    if (refreshToken == null) return;
    try {
      await _dio.post<void>(
        '/auth/logout',
        data: {'refreshToken': refreshToken},
      );
    } on DioException {
      // 端末側のトークンは消えているので、サーバーへの失効通知の失敗は無視する
    }
  }

  Future<void> _authenticate(String path, Map<String, String> body) async {
    final res = await _dio.post<Map<String, dynamic>>(path, data: body);
    await _session.save(Tokens.fromJson(res.data!));
  }
}

final authRepositoryProvider = Provider<AuthRepository>(
  (ref) =>
      AuthRepository(ref.watch(authDioProvider), ref.watch(sessionProvider)),
);
