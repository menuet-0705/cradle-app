import { ageInMonths, jstStartOfDay, reportPeriod } from './aggregate.js';

const jst = (s: string) => new Date(`${s}+09:00`);

describe('reportPeriod', () => {
  it('ends at the latest Friday 17:00 JST', () => {
    // 2026-10-02 は金曜
    expect(reportPeriod(jst('2026-10-02T17:00:00'))).toEqual({
      start: jst('2026-09-25T17:00:00'),
      end: jst('2026-10-02T17:00:00'),
    });
    // Cron が遅れても同じ期間
    expect(reportPeriod(jst('2026-10-02T17:59:00')).end).toEqual(
      jst('2026-10-02T17:00:00'),
    );
    expect(reportPeriod(jst('2026-10-04T09:00:00')).end).toEqual(
      jst('2026-10-02T17:00:00'),
    );
    // 金曜 17:00 より前は前週
    expect(reportPeriod(jst('2026-10-02T16:59:00')).end).toEqual(
      jst('2026-09-25T17:00:00'),
    );
  });
});

describe('ageInMonths', () => {
  it('counts completed months in JST', () => {
    const birth = new Date('2026-06-10T00:00:00Z');
    expect(ageInMonths(birth, jst('2026-09-09T12:00:00'))).toBe(2);
    expect(ageInMonths(birth, jst('2026-09-10T00:30:00'))).toBe(3);
    expect(ageInMonths(birth, jst('2026-06-01T00:00:00'))).toBe(0);
  });
});

describe('jstStartOfDay', () => {
  it('returns JST midnight', () => {
    expect(jstStartOfDay(jst('2026-09-29T08:30:00'))).toEqual(
      jst('2026-09-29T00:00:00'),
    );
    expect(jstStartOfDay(jst('2026-09-29T00:10:00'))).toEqual(
      jst('2026-09-29T00:00:00'),
    );
  });
});
