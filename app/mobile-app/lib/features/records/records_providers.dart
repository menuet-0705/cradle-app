import 'package:dio/dio.dart';
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
  Future<List<GrowthRecord>> listForDay(String childId, DateTime day) async {
    final from = DateTime(day.year, day.month, day.day);
    final to = DateTime(day.year, day.month, day.day + 1);
    final res = await _dio.get<List<dynamic>>(
      '/children/$childId/records',
      queryParameters: {
        'from': from.toUtc().toIso8601String(),
        'to': to.toUtc().toIso8601String(),
      },
    );
    return res.data!
        .map((e) => GrowthRecord.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<void> create(String childId, NewRecord record) =>
      _dio.post<void>('/children/$childId/records', data: record.toJson());

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
    final tz = await FlutterTimezone.getLocalTimezone();
    final res = await _dio.get<List<dynamic>>(
      '/children/$childId/stats/milk-daily',
      queryParameters: {
        'from': _date.format(from),
        'to': _date.format(to),
        'tz': tz.identifier,
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

  void shift(int days) {
    final base = state ?? today();
    final next = DateTime(base.year, base.month, base.day + days);
    state = next == today() ? null : next;
  }
}

final selectedDayProvider = NotifierProvider<SelectedDay, DateTime?>(
  SelectedDay.new,
);

final dayRecordsProvider = FutureProvider.autoDispose
    .family<List<GrowthRecord>, ({String childId, DateTime day})>(
      (ref, arg) =>
          ref.watch(recordsRepositoryProvider).listForDay(arg.childId, arg.day),
    );

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
