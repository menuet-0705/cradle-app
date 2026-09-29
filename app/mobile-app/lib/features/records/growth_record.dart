import 'package:flutter/material.dart';

enum RecordType {
  milk('MILK', 'ミルク', Icons.local_drink_outlined),
  sleep('SLEEP', '睡眠', Icons.bedtime_outlined),
  weight('WEIGHT', '体重', Icons.monitor_weight_outlined),
  meal('MEAL', '食事', Icons.restaurant_outlined);

  const RecordType(this.apiValue, this.label, this.icon);

  final String apiValue;
  final String label;
  final IconData icon;

  static RecordType fromApi(String value) =>
      values.firstWhere((t) => t.apiValue == value);
}

class GrowthRecord {
  const GrowthRecord({
    required this.id,
    required this.type,
    required this.startedAt,
    this.endedAt,
    this.amountMl,
    this.weightG,
    this.note,
    this.createdByName,
  });

  factory GrowthRecord.fromJson(Map<String, dynamic> json) => GrowthRecord(
    id: json['id'] as String,
    type: RecordType.fromApi(json['type'] as String),
    startedAt: DateTime.parse(json['startedAt'] as String).toLocal(),
    endedAt: json['endedAt'] == null
        ? null
        : DateTime.parse(json['endedAt'] as String).toLocal(),
    amountMl: json['amountMl'] as int?,
    weightG: json['weightG'] as int?,
    note: json['note'] as String?,
    createdByName:
        (json['createdBy'] as Map<String, dynamic>?)?['name'] as String?,
  );

  final String id;
  final RecordType type;
  final DateTime startedAt;
  final DateTime? endedAt;
  final int? amountMl;
  final int? weightG;
  final String? note;
  final String? createdByName;

  /// 一覧に出す要約
  String get summary => switch (type) {
    RecordType.milk => '${amountMl ?? 0} ml',
    RecordType.sleep => _duration(endedAt!.difference(startedAt)),
    RecordType.weight => '${((weightG ?? 0) / 1000).toStringAsFixed(2)} kg',
    RecordType.meal => note ?? '',
  };

  static String _duration(Duration d) {
    final h = d.inHours;
    final m = d.inMinutes % 60;
    return h > 0 ? '$h時間$m分' : '$m分';
  }
}

/// 記録作成時の入力値
class NewRecord {
  const NewRecord({
    required this.type,
    required this.startedAt,
    this.endedAt,
    this.amountMl,
    this.weightG,
    this.note,
  });

  final RecordType type;
  final DateTime startedAt;
  final DateTime? endedAt;
  final int? amountMl;
  final int? weightG;
  final String? note;

  /// [tz] は体重のときに「1日」を区切る端末のタイムゾーン（IANA 名）
  Map<String, dynamic> toJson({String? tz}) => {
    'type': type.apiValue,
    // タイムゾーン付きで送る（サーバーは UTC で保存）
    'startedAt': startedAt.toUtc().toIso8601String(),
    'endedAt': ?endedAt?.toUtc().toIso8601String(),
    'amountMl': ?amountMl,
    'weightG': ?weightG,
    'tz': ?tz,
    if (note != null && note!.isNotEmpty) 'note': note,
  };
}
