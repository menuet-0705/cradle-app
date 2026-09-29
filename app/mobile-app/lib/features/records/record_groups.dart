import 'growth_record.dart';

/// 記録一覧の 1 グループ（同じ種類の記録）
class RecordGroup {
  const RecordGroup(this.type, this.records);

  final RecordType type;

  /// 古い順（食事は区分の順、同じ区分なら古い順）
  final List<GrowthRecord> records;

  /// 見出し。件数と合計を添える（体重は 1 日 1 件なので種類名だけ）
  String get header {
    final count = '${type.label}  ${records.length}回';
    return switch (type) {
      RecordType.milk => '$count · 合計 $_totalMl ml',
      RecordType.sleep =>
        '$count · 合計 ${GrowthRecord.formatDuration(_totalSleep)}',
      RecordType.weight => type.label,
      RecordType.meal => count,
    };
  }

  int get _totalMl => records.fold(0, (sum, r) => sum + (r.amountMl ?? 0));

  // 日をまたぐ睡眠も、その日に始まった分として全時間を数える（一覧に出る範囲と同じ）
  Duration get _totalSleep => records.fold(
    Duration.zero,
    (sum, r) => sum + r.endedAt!.difference(r.startedAt),
  );
}

/// 種類ごとにまとめる。並びは RecordType の宣言順で、記録のない種類は含めない
List<RecordGroup> groupRecords(List<GrowthRecord> records) => [
  for (final type in RecordType.values)
    if (records.any((r) => r.type == type))
      RecordGroup(type, _sorted(records.where((r) => r.type == type).toList())),
];

List<GrowthRecord> _sorted(List<GrowthRecord> items) {
  // List.sort は安定ではないので、同じ順位は元の並びを保つよう位置で比べる
  final indexed = items.indexed.toList()
    ..sort((a, b) {
      final (ia, ra) = a;
      final (ib, rb) = b;
      // 区分の分からない食事は最後に
      final bySlot = (ra.mealSlot?.index ?? MealSlot.values.length).compareTo(
        rb.mealSlot?.index ?? MealSlot.values.length,
      );
      if (bySlot != 0) return bySlot;
      final byTime = ra.startedAt.compareTo(rb.startedAt);
      return byTime != 0 ? byTime : ia.compareTo(ib);
    });
  return [for (final (_, r) in indexed) r];
}
