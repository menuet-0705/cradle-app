import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter_timezone/flutter_timezone.dart';

// API が受け付けるタイムゾーン名（IANA 名。サーバーの検証と同じ形）
final _ianaName = RegExp(r'^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$');

/// 端末のタイムゾーン（IANA 名）。
/// 一部の端末は `GMT+09:00` のような名前を返すので、`Area/City` 形式と `UTC` 以外は
/// 現在の時差から `Etc/GMT-9`（IANA の Etc は符号が逆）を作る。
/// 時差が時間単位でなければ（例: +05:30）表せないので UTC にする（日の区切りがずれるのは許容）
Future<String> deviceTimeZone() async {
  final name = (await FlutterTimezone.getLocalTimezone()).identifier;
  return ianaTimeZoneOr(name, DateTime.now().timeZoneOffset);
}

@visibleForTesting
String ianaTimeZoneOr(String name, Duration offset) {
  if (_ianaName.hasMatch(name) && (name.contains('/') || name == 'UTC')) {
    return name;
  }
  if (offset.inMinutes % 60 != 0) return 'UTC';
  final hours = offset.inHours;
  if (hours == 0) return 'UTC';
  return 'Etc/GMT${hours > 0 ? '-' : '+'}${hours.abs()}';
}
