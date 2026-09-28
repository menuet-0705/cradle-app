import 'package:flutter_riverpod/flutter_riverpod.dart';

// 招待コードとして扱う文字列（形式の厳密な検証はサーバー側）
final _codePattern = RegExp(r'^[A-Za-z0-9-]{1,40}$');

/// 招待メールのリンク（`/invite#<コード>`）からコードを取り出す。
/// コードを # 以降に置くのは、サーバーに送られずアクセスログに残らないため
String? inviteCodeFromUrl(Uri uri) {
  if (uri.path != '/invite') return null;
  // 正しいコードに % は含まれないのでデコードしない（壊れたエスケープで起動時に落ちないように）
  final code = uri.fragment;
  return _codePattern.hasMatch(code) ? code : null;
}

/// 参加前の招待コード。ログイン・新規登録をはさんでも招待画面に戻れるよう、メモリ上に保持する
/// （URL には残さない）
class PendingInviteCode extends Notifier<String?> {
  PendingInviteCode([this._initial]);

  final String? _initial;

  @override
  String? build() => _initial;

  void set(String code) => state = _codePattern.hasMatch(code) ? code : state;

  void clear() => state = null;
}

final pendingInviteCodeProvider = NotifierProvider<PendingInviteCode, String?>(
  PendingInviteCode.new,
);
