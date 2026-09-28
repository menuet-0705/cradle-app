enum Sex { male, female }

class Child {
  const Child({
    required this.id,
    required this.name,
    required this.birthDate,
    this.sex,
  });

  factory Child.fromJson(Map<String, dynamic> json) => Child(
    id: json['id'] as String,
    name: json['name'] as String,
    // サーバーは日付を UTC 0時で返すので、日付部分だけ取り出してローカル日付にする
    birthDate: DateTime.parse((json['birthDate'] as String).substring(0, 10)),
    sex: switch (json['sex']) {
      'MALE' => Sex.male,
      'FEMALE' => Sex.female,
      _ => null,
    },
  );

  final String id;
  final String name;
  final DateTime birthDate;
  final Sex? sex;

  /// 例: 「0歳5か月」
  String ageLabel(DateTime now) {
    var months = (now.year - birthDate.year) * 12 + now.month - birthDate.month;
    if (now.day < birthDate.day) months--;
    if (months < 0) return '誕生前';
    return '${months ~/ 12}歳${months % 12}か月';
  }
}
