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

  /// 1 日 1 件（食事は区分ごとに 1 件）。同じ日の 2 回目はサーバーで上書きされる
  bool get oncePerDay => this == weight || this == meal;

  static RecordType fromApi(String value) =>
      values.firstWhere((t) => t.apiValue == value);
}

/// 食事の区分（宣言順 = 1 日の並び順）
enum MealSlot {
  breakfast('BREAKFAST', '朝食'),
  morningSnack('MORNING_SNACK', 'おやつ（午前）'),
  lunch('LUNCH', '昼食'),
  afternoonSnack('AFTERNOON_SNACK', 'おやつ（午後）'),
  dinner('DINNER', '夕食');

  const MealSlot(this.apiValue, this.label);

  final String apiValue;
  final String label;

  /// 知らない値（サーバーで区分が増えた場合など）は null にし、一覧を読めなくしない
  static MealSlot? fromApi(String value) =>
      values.where((s) => s.apiValue == value).firstOrNull;

  /// 時刻から決める初期値（既存データの割り当てと同じ区切り）
  static MealSlot at(DateTime time) => switch (time.hour) {
    < 10 => breakfast,
    < 11 => morningSnack,
    < 14 => lunch,
    < 17 => afternoonSnack,
    _ => dinner,
  };
}

class GrowthRecord {
  const GrowthRecord({
    required this.id,
    required this.type,
    required this.startedAt,
    this.endedAt,
    this.amountMl,
    this.weightG,
    this.mealSlot,
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
    mealSlot: switch (json['mealSlot']) {
      final String v => MealSlot.fromApi(v),
      _ => null,
    },
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
  final MealSlot? mealSlot;
  final String? note;
  final String? createdByName;

  /// 一覧に出す名前（食事は区分）
  String get label => mealSlot?.label ?? type.label;

  /// 一覧に出す要約
  String get summary => switch (type) {
    RecordType.milk => '${amountMl ?? 0} ml',
    RecordType.sleep => formatDuration(endedAt!.difference(startedAt)),
    RecordType.weight => '${((weightG ?? 0) / 1000).toStringAsFixed(2)} kg',
    RecordType.meal => note ?? '',
  };

  static String formatDuration(Duration d) {
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
    this.mealSlot,
    this.note,
  });

  final RecordType type;
  final DateTime startedAt;
  final DateTime? endedAt;
  final int? amountMl;
  final int? weightG;
  final MealSlot? mealSlot;
  final String? note;

  /// [tz] は体重・食事のときに「1日」を区切る端末のタイムゾーン（IANA 名）
  Map<String, dynamic> toJson({String? tz}) => {
    'type': type.apiValue,
    // タイムゾーン付きで送る（サーバーは UTC で保存）
    'startedAt': startedAt.toUtc().toIso8601String(),
    'endedAt': ?endedAt?.toUtc().toIso8601String(),
    'amountMl': ?amountMl,
    'weightG': ?weightG,
    'mealSlot': ?mealSlot?.apiValue,
    'tz': ?tz,
    if (note != null && note!.isNotEmpty) 'note': note,
  };
}
