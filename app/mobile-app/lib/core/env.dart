import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';

/// 接続先は `--dart-define=API_BASE_URL=...` で切り替える（コードは環境で分岐させない）。
/// 未指定時はローカル開発用。Android エミュレータからホスト PC は 10.0.2.2 で見える。
class Env {
  static const _apiBaseUrl = String.fromEnvironment('API_BASE_URL');

  static String get apiBaseUrl {
    if (_apiBaseUrl.isNotEmpty) return _apiBaseUrl;
    if (!kDebugMode) {
      throw StateError('API_BASE_URL must be set outside debug builds');
    }
    final host = !kIsWeb && Platform.isAndroid ? '10.0.2.2' : 'localhost';
    return 'http://$host:3000/api/v1';
  }

  /// デバッグ以外（profile / release）で平文 HTTP の接続先を使わないようにする
  static void validate() {
    final url = apiBaseUrl;
    if (!kDebugMode && !url.startsWith('https://')) {
      throw StateError('API_BASE_URL must use https outside debug builds');
    }
  }
}
