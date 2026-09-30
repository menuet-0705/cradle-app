import 'package:flutter/material.dart' show DateUtils;

/// カレンダーに出す 1 日分の要約（サーバーは記録がある日だけ返す）
class DailySummary {
  const DailySummary({
    required this.date,
    this.milkMl = 0,
    this.milkCount = 0,
    this.sleepMinutes = 0,
    this.sleepCount = 0,
    this.weightG,
    this.mealCount = 0,
  });

  factory DailySummary.fromJson(Map<String, dynamic> json) => DailySummary(
    // YYYY-MM-DD（端末のタイムゾーンで区切った日付）。ローカルの日付として扱う
    date: DateUtils.dateOnly(DateTime.parse(json['date'] as String)),
    milkMl: json['milkMl'] as int,
    milkCount: json['milkCount'] as int,
    sleepMinutes: json['sleepMinutes'] as int,
    sleepCount: json['sleepCount'] as int,
    weightG: json['weightG'] as int?,
    mealCount: json['mealCount'] as int,
  );

  final DateTime date;
  final int milkMl;
  final int milkCount;

  /// その日に始まった睡眠の合計（日をまたぐ睡眠も全時間を始まった日に数える）
  final int sleepMinutes;
  final int sleepCount;

  /// その日の体重（1 日 1 件）
  final int? weightG;
  final int mealCount;
}

/// 月のまとめ。平均は「記録した日」の平均（記録しなかった日を 0 として数えない）
class MonthTotals {
  const MonthTotals({
    required this.recordedDays,
    required this.milkAvgMl,
    required this.sleepAvgMinutes,
    required this.firstWeightG,
    required this.lastWeightG,
    required this.mealCount,
  });

  factory MonthTotals.of(Iterable<DailySummary> days) {
    final sorted = days.toList()..sort((a, b) => a.date.compareTo(b.date));
    final milkDays = sorted.where((d) => d.milkCount > 0).toList();
    final sleepDays = sorted.where((d) => d.sleepCount > 0).toList();
    final weights = [for (final d in sorted) ?d.weightG];
    int? avg(List<DailySummary> xs, int Function(DailySummary) f) => xs.isEmpty
        ? null
        : (xs.fold(0, (sum, d) => sum + f(d)) / xs.length).round();
    return MonthTotals(
      recordedDays: sorted.length,
      milkAvgMl: avg(milkDays, (d) => d.milkMl),
      sleepAvgMinutes: avg(sleepDays, (d) => d.sleepMinutes),
      firstWeightG: weights.firstOrNull,
      lastWeightG: weights.lastOrNull,
      mealCount: sorted.fold(0, (sum, d) => sum + d.mealCount),
    );
  }

  final int recordedDays;
  final int? milkAvgMl;
  final int? sleepAvgMinutes;
  final int? firstWeightG;
  final int? lastWeightG;
  final int mealCount;
}
