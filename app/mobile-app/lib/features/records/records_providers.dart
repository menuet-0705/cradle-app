import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart' show DateUtils;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/providers.dart';
import '../../core/time_zone.dart';
import '../ai/ai_providers.dart' show chartCommentProvider;
import 'daily_summary.dart';
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

  /// カレンダー用の 1 日ごとの要約（[from]〜[to] の日付を含む。記録がある日だけ返る）
  Future<List<DailySummary>> dailySummary(
    String childId, {
    required DateTime from,
    required DateTime to,
    CancelToken? cancelToken,
  }) async {
    final tz = await deviceTimeZone();
    final res = await _dio.get<List<dynamic>>(
      '/children/$childId/stats/daily-summary',
      queryParameters: {
        'from': _date.format(from),
        'to': _date.format(to),
        'tz': tz,
      },
      cancelToken: cancelToken,
    );
    return res.data!
        .map((e) => DailySummary.fromJson(e as Map<String, dynamic>))
        .toList();
  }
}

final recordsRepositoryProvider = Provider<RecordsRepository>(
  (ref) => RecordsRepository(ref.watch(dioProvider)),
);

DateTime today() => DateUtils.dateOnly(DateTime.now());

/// 記録タブでさかのぼれる日数（日の表示のページ数 - 1。月の表示でもこれより前の日は選べない）
const recordsMaxPastDays = 3650;

/// 記録画面で表示中の日付。null は「今日」を表し、日付をまたいでも古い日付に固定されない
class SelectedDay extends Notifier<DateTime?> {
  @override
  DateTime? build() {
    ref.watch(isLoggedInProvider);
    return null;
  }

  /// 表示する日を選ぶ（日の表示のページ送り・月の表示のカレンダーから呼ぶ。
  /// 今日より先の日と、[recordsMaxPastDays] 日より前の日は渡さない）
  void select(DateTime day) {
    final date = DateUtils.dateOnly(day);
    assert(!date.isAfter(today()), 'future day: $date');
    assert(
      today().difference(date).inDays <= recordsMaxPastDays + 1,
      'too old day: $date',
    );
    state = date == today() ? null : date;
  }
}

final selectedDayProvider = NotifierProvider<SelectedDay, DateTime?>(
  SelectedDay.new,
);

/// 記録タブの表示（1 日ごとの一覧・月間カレンダー）
enum RecordsView { day, month }

/// 記録タブで選んでいる表示。グラフ・AI のタブへ移って戻っても保ち、ログアウトで日に戻す
class SelectedRecordsView extends Notifier<RecordsView> {
  @override
  RecordsView build() {
    ref.watch(isLoggedInProvider);
    return RecordsView.day;
  }

  void select(RecordsView view) => state = view;
}

final recordsViewProvider = NotifierProvider<SelectedRecordsView, RecordsView>(
  SelectedRecordsView.new,
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

/// 月を行き来したときに読み込み直さないよう、カレンダーの月を画面から外れてから残しておく時間
const _monthCacheDuration = Duration(minutes: 5);

/// 月間カレンダーの 1 か月分（[month] は月の 1 日）。日付 → その日の要約
final monthSummaryProvider = FutureProvider.autoDispose
    .family<Map<DateTime, DailySummary>, ({String childId, DateTime month})>((
      ref,
      arg,
    ) async {
      // ログアウトしたら、残しておいた月も捨てる（ログアウト中は取得しない）
      if (!ref.watch(isLoggedInProvider)) return const {};
      // 画面から外れた月は、読み込み途中でも通信を止める
      final cancel = CancelToken();
      ref.onDispose(cancel.cancel);
      final m = arg.month;
      final days = await ref
          .watch(recordsRepositoryProvider)
          .dailySummary(
            arg.childId,
            from: DateTime(m.year, m.month),
            to: DateTime(m.year, m.month + 1, 0),
            cancelToken: cancel,
          );
      // 取得できた月だけ残す（失敗した月は、次に開いたときに取り直す）
      final link = ref.keepAlive();
      Timer? timer;
      ref.onCancel(() => timer = Timer(_monthCacheDuration, link.close));
      ref.onResume(() => timer?.cancel());
      ref.onDispose(() => timer?.cancel());
      return {for (final d in days) d.date: d};
    });

/// 記録の追加・削除後に、関連する表示をまとめて再取得する
void invalidateRecords(WidgetRef ref) {
  ref.invalidate(dayRecordsProvider);
  ref.invalidate(monthSummaryProvider);
  ref.invalidate(weightSeriesProvider);
  ref.invalidate(milkDailyProvider);
  // グラフの AI コメントも、データが変わったかどうかを判定し直す
  ref.invalidate(chartCommentProvider);
}
