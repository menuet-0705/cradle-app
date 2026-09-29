import 'package:cradle/core/time_zone.dart';
import 'package:cradle/features/children/child.dart';
import 'package:cradle/features/records/growth_record.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Child', () {
    test('parses birthDate as a local date regardless of time zone', () {
      final child = Child.fromJson({
        'id': 'c1',
        'name': 'たろう',
        'birthDate': '2026-04-01T00:00:00.000Z',
        'sex': 'MALE',
      });
      expect(child.birthDate, DateTime(2026, 4, 1));
      expect(child.sex, Sex.male);
    });

    test('ageLabel counts completed months', () {
      final child = Child(id: 'c', name: 'x', birthDate: DateTime(2025, 4, 15));
      expect(child.ageLabel(DateTime(2026, 9, 14)), '1歳4か月');
      expect(child.ageLabel(DateTime(2026, 9, 15)), '1歳5か月');
      expect(child.ageLabel(DateTime(2025, 4, 15)), '0歳0か月');
    });
  });

  group('GrowthRecord', () {
    test('summarizes each type', () {
      GrowthRecord r(Map<String, dynamic> extra) => GrowthRecord.fromJson({
        'id': 'r',
        'startedAt': '2026-09-28T01:00:00.000Z',
        'endedAt': null,
        'note': null,
        'createdBy': {'id': 'u', 'name': 'ママ'},
        ...extra,
      });

      expect(r({'type': 'MILK', 'amountMl': 120}).summary, '120 ml');
      expect(r({'type': 'WEIGHT', 'weightG': 5250}).summary, '5.25 kg');
      expect(
        r({'type': 'SLEEP', 'endedAt': '2026-09-28T03:30:00.000Z'}).summary,
        '2時間30分',
      );
      expect(r({'type': 'MEAL', 'note': 'おかゆ'}).summary, 'おかゆ');
      expect(r({'type': 'MILK', 'amountMl': 1}).createdByName, 'ママ');
    });
  });

  group('NewRecord', () {
    test('sends the time zone only when given (weight)', () {
      final json = NewRecord(
        type: RecordType.weight,
        startedAt: DateTime.utc(2026, 9, 28, 1),
        weightG: 5250,
      ).toJson(tz: 'Asia/Tokyo');
      expect(json, {
        'type': 'WEIGHT',
        'startedAt': '2026-09-28T01:00:00.000Z',
        'weightG': 5250,
        'tz': 'Asia/Tokyo',
      });
    });

    test('sends UTC timestamps and only relevant fields', () {
      final json = NewRecord(
        type: RecordType.milk,
        startedAt: DateTime.utc(2026, 9, 28, 1),
        amountMl: 100,
        note: '',
      ).toJson();
      expect(json, {
        'type': 'MILK',
        'startedAt': '2026-09-28T01:00:00.000Z',
        'amountMl': 100,
      });
    });
  });

  test('device time zone falls back to an IANA name', () {
    const jst = Duration(hours: 9);
    expect(ianaTimeZoneOr('Asia/Tokyo', jst), 'Asia/Tokyo');
    expect(ianaTimeZoneOr('UTC', Duration.zero), 'UTC');
    expect(ianaTimeZoneOr('GMT+09:00', jst), 'Etc/GMT-9');
    expect(ianaTimeZoneOr('GMT-05:00', const Duration(hours: -5)), 'Etc/GMT+5');
    expect(ianaTimeZoneOr('GMT', Duration.zero), 'UTC');
    // 時間単位でない時差は Etc で表せない
    expect(
      ianaTimeZoneOr('GMT+05:30', const Duration(hours: 5, minutes: 30)),
      'UTC',
    );
  });
}
