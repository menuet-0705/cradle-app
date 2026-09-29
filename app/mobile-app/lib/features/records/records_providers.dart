import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter/material.dart' show DateUtils;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_timezone/flutter_timezone.dart';
import 'package:intl/intl.dart';

import '../../core/providers.dart';
import 'growth_record.dart';

class WeightPoint {
  const WeightPoint(this.date, this.weightG);
  final DateTime date;
  final int weightG;
}

class MilkDaily {
  const MilkDaily(this.date, this.totalMl, this.count);
  final DateTime date;
  final int totalMl;
  final int count;
}

class RecordsRepository {
  RecordsRepository(this._dio);

  final Dio _dio;
  static final _date = DateFormat('yyyy-MM-dd');

  /// 端末ローカルの1日分
  Future<List<GrowthRecord>> listForDay(
    String childId,
    DateTime day, {
    CancelToken? cancelToken,
  }) async {
    final from = DateTime(day.year, day.month, day.day);
    final to = DateTime(day.year, day.month, day.day + 1);
    final res = await _dio.get<List<dynamic>>(
      '/children/$childId/records',
      queryParameters: {
        'from': from.toUtc().toIso8601String(),
        'to': to.toUtc().toIso8601String(),
      },
      cancelToken: cancelToken,
    );
    return res.data!
        .map((e) => GrowthRecord.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<void> create(String childId, NewRecord record) async {
    // 体重・食事は 1 日 1 件（同じ日の 2 回目は上書き）。その「1日」を端末のタイムゾーンで区切る
    final tz = record.type.oncePerDay ? await deviceTimeZone() : null;
    await _dio.post<void>(
      '/children/$childId/records',
      data: record.toJson(tz: tz),
    );
  }

  /// 記録の修正（種類は変えられない）。体重・食事を別の記録がある日（・区分）に移すと 409
  Future<void> update(String recordId, NewRecord record) async {
    final tz = record.type.oncePerDay ? await deviceTimeZone() : null;
    await _dio.patch<void>('/records/$recordId', data: record.toJson(tz: tz));
  }

  Future<void> delete(String recordId) =>
      _dio.delete<void>('/records/$recordId');

  Future<List<WeightPoint>> weightSeries(String childId) async {
    final res = await _dio.get<List<dynamic>>(
      '/children/$childId/stats/weight',
    );
    return res.data!.cast<Map<String, dynamic>>().map((e) {
      return WeightPoint(
        DateTime.parse(e['startedAt'] as String).toLocal(),
        e['weightG'] as int,
      );
    }).toList();
  }

  Future<List<MilkDaily>> milkDaily(
    String childId, {
    required DateTime from,
    required DateTime to,
  }) async {
    final tz = await deviceTimeZone();
    final res = await _dio.get<List<dynamic>>(
      '/children/$childId/stats/milk-daily',
      queryParameters: {
        'from': _date.format(from),
        'to': _date.format(to),
        'tz': tz,
      },
    );
    return res.data!.cast<Map<String, dynamic>>().map((e) {
      return MilkDaily(
        DateTime.parse(e['date'] as String),
        e['totalMl'] as int,
        e['count'] as int,
      );
    }).toList();
  }
}

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

final recordsRepositoryProvider = Provider<RecordsRepository>(
  (ref) => RecordsRepository(ref.watch(dioProvider)),
);

DateTime today() => DateUtils.dateOnly(DateTime.now());

/// 記録画面で表示中の日付。null は「今日」を表し、日付をまたいでも古い日付に固定されない
class SelectedDay extends Notifier<DateTime?> {
  @override
  DateTime? build() {
    ref.watch(isLoggedInProvider);
    return null;
  }

  /// 表示する日を選ぶ（記録画面のページ送りから呼ぶ。今日より先の日は渡さない）
  void select(DateTime day) {
    final date = DateUtils.dateOnly(day);
    assert(!date.isAfter(today()), 'future day: $date');
    state = date == today() ? null : date;
  }
}

final selectedDayProvider = NotifierProvider<SelectedDay, DateTime?>(
  SelectedDay.new,
);

final dayRecordsProvider = FutureProvider.autoDispose
    .family<List<GrowthRecord>, ({String childId, DateTime day})>((ref, arg) {
      // 記録画面をめくって画面から外れた日は、読み込み途中でも通信を止める
      final cancel = CancelToken();
      ref.onDispose(cancel.cancel);
      return ref
          .watch(recordsRepositoryProvider)
          .listForDay(arg.childId, arg.day, cancelToken: cancel);
    });

final weightSeriesProvider = FutureProvider.autoDispose
    .family<List<WeightPoint>, String>(
      (ref, childId) =>
          ref.watch(recordsRepositoryProvider).weightSeries(childId),
    );

const milkChartDays = 14;

/// 直近2週間の1日ごとのミルク量
final milkDailyProvider = FutureProvider.autoDispose
    .family<List<MilkDaily>, String>((ref, childId) {
      final now = DateTime.now();
      final to = DateTime(now.year, now.month, now.day);
      final from = DateTime(to.year, to.month, to.day - (milkChartDays - 1));
      return ref
          .watch(recordsRepositoryProvider)
          .milkDaily(childId, from: from, to: to);
    });

/// 記録の追加・削除後に、関連する表示をまとめて再取得する
void invalidateRecords(WidgetRef ref) {
  ref.invalidate(dayRecordsProvider);
  ref.invalidate(weightSeriesProvider);
  ref.invalidate(milkDailyProvider);
}
