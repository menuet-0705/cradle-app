import 'package:cradle/features/records/growth_record.dart';
import 'package:cradle/features/records/record_groups.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final day = DateTime(2026, 9, 28);
  DateTime at(int hour, [int minute = 0]) =>
      DateTime(day.year, day.month, day.day, hour, minute);

  GrowthRecord record(
    String id,
    RecordType type,
    DateTime startedAt, {
    DateTime? endedAt,
    int? amountMl,
    int? weightG,
    MealSlot? mealSlot,
  }) => GrowthRecord(
    id: id,
    type: type,
    startedAt: startedAt,
    endedAt: endedAt,
    amountMl: amountMl,
    weightG: weightG,
    mealSlot: mealSlot,
    note: type == RecordType.meal ? id : null,
  );

  group('groupRecords', () {
    test('groups by type in declaration order, oldest first', () {
      // API は新しい順で返す
      final groups = groupRecords([
        record(
          'meal-dinner',
          RecordType.meal,
          at(18),
          mealSlot: MealSlot.dinner,
        ),
        record('milk-9', RecordType.milk, at(9), amountMl: 120),
        record('weight', RecordType.weight, at(8), weightG: 5250),
        record('milk-6', RecordType.milk, at(6), amountMl: 100),
        record('sleep', RecordType.sleep, at(1), endedAt: at(4, 30)),
        record(
          'meal-breakfast',
          RecordType.meal,
          at(7),
          mealSlot: MealSlot.breakfast,
        ),
      ]);

      expect(groups.map((g) => g.type), [
        RecordType.milk,
        RecordType.sleep,
        RecordType.weight,
        RecordType.meal,
      ]);
      expect(groups.first.records.map((r) => r.id), ['milk-6', 'milk-9']);
      expect(groups.last.records.map((r) => r.id), [
        'meal-breakfast',
        'meal-dinner',
      ]);
    });

    test('leaves out types without records', () {
      final groups = groupRecords([
        record('milk', RecordType.milk, at(6), amountMl: 100),
      ]);
      expect(groups.map((g) => g.type), [RecordType.milk]);
      expect(groupRecords(const []), isEmpty);
    });

    test('orders meals by slot, then by time', () {
      // 区分は時刻と関係なく選べるので、区分の順を優先する
      final groups = groupRecords([
        record('lunch', RecordType.meal, at(11), mealSlot: MealSlot.lunch),
        record(
          'am-snack',
          RecordType.meal,
          at(11, 30),
          mealSlot: MealSlot.morningSnack,
        ),
        record('dinner', RecordType.meal, at(17), mealSlot: MealSlot.dinner),
        record(
          'pm-snack',
          RecordType.meal,
          at(15),
          mealSlot: MealSlot.afternoonSnack,
        ),
        record(
          'breakfast',
          RecordType.meal,
          at(8),
          mealSlot: MealSlot.breakfast,
        ),
      ]);
      expect(groups.single.records.map((r) => r.id), [
        'breakfast',
        'am-snack',
        'lunch',
        'pm-snack',
        'dinner',
      ]);
    });

    test('orders meals of the same slot by time (older data)', () {
      final groups = groupRecords([
        record('late', RecordType.meal, at(8), mealSlot: MealSlot.breakfast),
        record('early', RecordType.meal, at(7), mealSlot: MealSlot.breakfast),
      ]);
      expect(groups.single.records.map((r) => r.id), ['early', 'late']);
    });

    test('puts meals of an unknown slot last', () {
      final groups = groupRecords([
        record('unknown', RecordType.meal, at(6)),
        record('dinner', RecordType.meal, at(18), mealSlot: MealSlot.dinner),
      ]);
      expect(groups.single.records.map((r) => r.id), ['dinner', 'unknown']);
    });

    test('keeps the original order for the same time', () {
      final groups = groupRecords([
        record('b', RecordType.milk, at(6), amountMl: 100),
        record('a', RecordType.milk, at(6), amountMl: 100),
      ]);
      expect(groups.single.records.map((r) => r.id), ['b', 'a']);
    });
  });

  group('RecordGroup.header', () {
    test('shows count and total', () {
      final groups = groupRecords([
        record('m1', RecordType.milk, at(6), amountMl: 100),
        record('m2', RecordType.milk, at(9), amountMl: 120),
        // 日をまたぐ睡眠も全時間を数える
        record('s1', RecordType.sleep, at(13), endedAt: at(14, 30)),
        record(
          's2',
          RecordType.sleep,
          at(21),
          endedAt: DateTime(2026, 9, 29, 6),
        ),
        record('w', RecordType.weight, at(8), weightG: 5250),
        record('f1', RecordType.meal, at(7), mealSlot: MealSlot.breakfast),
        record('f2', RecordType.meal, at(12), mealSlot: MealSlot.lunch),
        record('f3', RecordType.meal, at(18), mealSlot: MealSlot.dinner),
      ]);
      expect(groups.map((g) => g.header), [
        'ミルク  2回 · 合計 220 ml',
        '睡眠  2回 · 合計 10時間30分',
        '体重',
        '食事  3回',
      ]);
    });
  });

  group('MealSlot', () {
    test('picks the default slot from the time', () {
      expect(MealSlot.at(at(0)), MealSlot.breakfast);
      expect(MealSlot.at(at(9, 59)), MealSlot.breakfast);
      expect(MealSlot.at(at(10)), MealSlot.morningSnack);
      expect(MealSlot.at(at(11)), MealSlot.lunch);
      expect(MealSlot.at(at(13, 59)), MealSlot.lunch);
      expect(MealSlot.at(at(14)), MealSlot.afternoonSnack);
      expect(MealSlot.at(at(17)), MealSlot.dinner);
      expect(MealSlot.at(at(23, 59)), MealSlot.dinner);
    });

    test('is read from and sent to the API', () {
      final meal = GrowthRecord.fromJson({
        'id': 'r',
        'type': 'MEAL',
        'startedAt': '2026-09-28T01:00:00.000Z',
        'mealSlot': 'MORNING_SNACK',
        'note': 'バナナ',
      });
      expect(meal.mealSlot, MealSlot.morningSnack);
      expect(meal.label, 'おやつ（午前）');

      final milk = GrowthRecord.fromJson({
        'id': 'r',
        'type': 'MILK',
        'startedAt': '2026-09-28T01:00:00.000Z',
        'mealSlot': null,
        'amountMl': 100,
      });
      expect(milk.label, 'ミルク');

      // 知らない区分でも一覧は読める（種類名で表示）
      final unknown = GrowthRecord.fromJson({
        'id': 'r',
        'type': 'MEAL',
        'startedAt': '2026-09-28T01:00:00.000Z',
        'mealSlot': 'MIDNIGHT_SNACK',
        'note': 'x',
      });
      expect(unknown.mealSlot, isNull);
      expect(unknown.label, '食事');

      final json = NewRecord(
        type: RecordType.meal,
        startedAt: DateTime.utc(2026, 9, 28, 1),
        mealSlot: MealSlot.lunch,
        note: 'うどん',
      ).toJson(tz: 'Asia/Tokyo');
      expect(json, {
        'type': 'MEAL',
        'startedAt': '2026-09-28T01:00:00.000Z',
        'mealSlot': 'LUNCH',
        'tz': 'Asia/Tokyo',
        'note': 'うどん',
      });
    });
  });
}
