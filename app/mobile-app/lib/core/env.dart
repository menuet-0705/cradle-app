import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';

/// 接続先は `--dart-define=API_BASE_URL=...` で切り替える（コードは環境で分岐させない）。
///
/// - Web: 未指定なら配信元と同じオリジンの `/api/v1`（本番は Vercel、ローカルは開発サーバーのプロキシ経由）
/// - モバイル: 未指定ならローカル開発用。Android エミュレータからホスト PC は 10.0.2.2 で見える
class Env {
  static const _apiBaseUrl = String.fromEnvironment('API_BASE_URL');

  static String get apiBaseUrl {
    if (_apiBaseUrl.isNotEmpty) return _apiBaseUrl;
    if (kIsWeb) return Uri.base.resolve('/api/v1').toString();
    if (!kDebugMode) {
      throw StateError('API_BASE_URL must be set outside debug builds');
    }
    final host = !kIsWeb && Platform.isAndroid ? '10.0.2.2' : 'localhost';
    return 'http://$host:3000/api/v1';
  }

  /// デバッグ以外（profile / release）で平文 HTTP の接続先を使わないようにする。
  /// Web のリリースビルドを手元（http://localhost）で確認する場合だけは許可する
  static void validate() {
    final uri = Uri.parse(apiBaseUrl);
    final isLocalWeb =
        kIsWeb && (uri.host == 'localhost' || uri.host == '127.0.0.1');
    if (!kDebugMode && uri.scheme != 'https' && !isLocalWeb) {
      throw StateError('API_BASE_URL must use https outside debug builds');
    }
    // Web のログイン維持は同一オリジンの Cookie に依存する（別オリジンでは Cookie が送られない）
    if (kIsWeb && uri.origin != Uri.base.origin) {
      throw StateError('API_BASE_URL must be same-origin on web');
    }
  }
}
