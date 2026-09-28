import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class Tokens {
  const Tokens({required this.accessToken, required this.refreshToken});

  factory Tokens.fromJson(Map<String, dynamic> json) => Tokens(
    accessToken: json['accessToken'] as String,
    refreshToken: json['refreshToken'] as String,
  );

  final String accessToken;
  final String refreshToken;
}

/// ログイン状態。トークンは端末のセキュアストレージ（Keychain / Keystore）に保存する。
/// ルーターの refreshListenable にも使う。
class Session extends ChangeNotifier {
  Session({FlutterSecureStorage? storage})
    : _storage =
          storage ??
          const FlutterSecureStorage(
            // 端末外（バックアップ・他端末）にトークンを持ち出さない
            iOptions: IOSOptions(
              accessibility: KeychainAccessibility.first_unlock_this_device,
            ),
          );

  static const _accessKey = 'access_token';
  static const _refreshKey = 'refresh_token';

  final FlutterSecureStorage _storage;
  Tokens? _tokens;
  int _epoch = 0;

  /// ログアウトのたびに増える。通信中にログアウトされたかの判定に使う
  int get epoch => _epoch;

  Tokens? get tokens => _tokens;
  bool get isLoggedIn => _tokens != null;

  Future<void> load() async {
    final access = await _storage.read(key: _accessKey);
    final refresh = await _storage.read(key: _refreshKey);
    if (access != null && refresh != null) {
      _tokens = Tokens(accessToken: access, refreshToken: refresh);
    }
  }

  /// [expectedEpoch] を渡すと、保存中にログアウトされた場合は保存を取り消して false を返す
  Future<bool> save(Tokens tokens, {int? expectedEpoch}) async {
    bool stale() => expectedEpoch != null && _epoch != expectedEpoch;
    if (stale()) return false;
    await _storage.write(key: _accessKey, value: tokens.accessToken);
    await _storage.write(key: _refreshKey, value: tokens.refreshToken);
    if (stale()) {
      // 書き込み中にログアウト（や再ログイン）されていたら、現在の状態に戻す
      await _persist(_tokens);
      return false;
    }
    final wasLoggedIn = isLoggedIn;
    _tokens = tokens;
    if (!wasLoggedIn) notifyListeners();
    return true;
  }

  Future<void> _persist(Tokens? tokens) async {
    if (tokens == null) {
      await _storage.delete(key: _accessKey);
      await _storage.delete(key: _refreshKey);
    } else {
      await _storage.write(key: _accessKey, value: tokens.accessToken);
      await _storage.write(key: _refreshKey, value: tokens.refreshToken);
    }
  }

  Future<void> clear() async {
    _epoch++;
    await _persist(null);
    if (_tokens == null) return;
    _tokens = null;
    notifyListeners();
  }
}
