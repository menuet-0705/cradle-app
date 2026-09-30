import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../features/auth/session.dart';
import 'refresh_lock.dart';

Dio createBareDio(String baseUrl) => Dio(
  BaseOptions(
    baseUrl: baseUrl,
    connectTimeout: const Duration(seconds: 10),
    receiveTimeout: const Duration(seconds: 20),
    contentType: Headers.jsonContentType,
    // Web はリフレッシュトークンを HttpOnly Cookie で受け渡す（サーバーはこのヘッダーで判別）
    headers: {if (kIsWeb) 'X-Auth-Mode': 'cookie'},
  ),
);

/// リフレッシュトークンの送り方。Web は Cookie で自動的に送られるので本文は空
Map<String, String>? refreshTokenBody(String? refreshToken) =>
    refreshToken == null ? null : {'refreshToken': refreshToken};

/// 認証付きの Dio。アクセストークン切れ（401）なら一度だけリフレッシュして再送する。
Dio createAuthedDio(String baseUrl, Session session) {
  final dio = createBareDio(baseUrl);
  final refreshDio = createBareDio(baseUrl);
  Future<bool>? refreshing;

  Future<bool> refresh() async {
    final current = session.tokens;
    if (current == null) return false;
    final epoch = session.epoch;
    try {
      final res = await refreshDio.post<Map<String, dynamic>>(
        '/auth/refresh',
        data: refreshTokenBody(current.refreshToken),
      );
      // 通信中・保存中にログアウトされていたら、新しいトークンで再ログインさせない
      final issued = Tokens.fromJson(res.data!);
      if (session.epoch != epoch ||
          !await session.save(issued, expectedEpoch: epoch)) {
        // ロックを持ったまま失効させる（他タブの更新と重ならないように）
        try {
          await refreshDio.post<void>(
            '/auth/logout',
            data: refreshTokenBody(issued.refreshToken),
          );
        } catch (_) {}
        return false;
      }
      return true;
    } on DioException catch (e) {
      // 通信エラーではログアウトさせない。拒否された場合のみセッションを破棄する
      if (e.response?.statusCode == 401 && session.epoch == epoch) {
        await session.clear();
      }
      return false;
    } catch (_) {
      // 保存失敗・想定外のレスポンスでも元のリクエストを止めない
      return false;
    }
  }

  dio.interceptors.add(
    InterceptorsWrapper(
      onRequest: (options, handler) {
        final token = session.tokens?.accessToken;
        if (token != null) options.headers['Authorization'] = 'Bearer $token';
        handler.next(options);
      },
      onError: (error, handler) async {
        final options = error.requestOptions;
        if (error.response?.statusCode != 401 ||
            options.extra['retried'] == true) {
          return handler.next(error);
        }
        // 同時に複数のリクエストが 401 になっても、リフレッシュは 1 回にまとめる
        // Web は他のタブとも排他する（withRefreshLock）
        final ok = await (refreshing ??= withRefreshLock(refresh)
            .whenComplete(() => refreshing = null));
        final token = session.tokens?.accessToken;
        if (!ok || token == null) return handler.next(error);
        try {
          options.extra['retried'] = true;
          options.headers['Authorization'] = 'Bearer $token';
          handler.resolve(await dio.fetch<dynamic>(options));
        } on DioException catch (e) {
          handler.next(e);
        } catch (_) {
          handler.next(error);
        }
      },
    ),
  );
  return dio;
}

/// 画面に出すエラーメッセージ
String errorMessage(Object error) {
  if (error is DioException) {
    final status = error.response?.statusCode;
    final data = error.response?.data;
    final serverMessage = data is Map ? data['message'] : null;
    switch (status) {
      case null:
        return 'サーバーに接続できませんでした。通信環境を確認してください';
      case 400:
        return '入力内容を確認してください';
      case 401:
        return serverMessage == 'Invalid credentials'
            ? 'メールアドレスまたはパスワードが違います'
            : 'ログインが必要です';
      case 404:
        return 'データが見つかりませんでした';
      case 409 when data is Map && data['code'] == 'DUPLICATE_RECORD':
        return 'その日の記録はすでにあります。日付を変えるか、そちらの記録を修正してください';
      case 409 when data is Map && data['code'] == 'TOO_MANY_CHILDREN':
        return '1 つの家族に登録できるこどもは 10 人までです';
      case 409 when data is Map && data['code'] == 'LAST_CHILD':
        return '家族のこどもが 1 人だけのときは削除できません';
      case 409:
        return 'このメールアドレスは既に登録されています';
      case 429:
        return '試行回数が多すぎます。しばらく待ってから再度お試しください';
      default:
        return 'エラーが発生しました（$status）';
    }
  }
  return 'エラーが発生しました';
}
