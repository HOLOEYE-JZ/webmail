import { describe, expect, it } from 'vitest';
import { dayOfIso, isoDay, parseDate, utcDateTime } from '../task-dates';

describe('task dates', () => {
  it('writes a UTCDateTime without fractional seconds', () => {
    expect(utcDateTime(new Date('2026-10-25T08:30:00.123Z'))).toBe('2026-10-25T08:30:00Z');
  });

  it('reads an ISO date or date-time, nothing else', () => {
    expect(parseDate('2026-10-25T08:30:00Z')?.toISOString()).toBe('2026-10-25T08:30:00.000Z');
    expect(parseDate('2026-10-25T08:30:00')?.getHours()).toBe(8);
    expect(parseDate('soon')).toBeNull();
    expect(parseDate(null)).toBeNull();
    expect(parseDate(42)).toBeNull();
  });

  it('writes a day as yyyy-MM-dd and reads it back as local midnight, with a time when given', () => {
    const day = new Date(2026, 9, 5);
    expect(isoDay(day)).toBe('2026-10-05');
    expect(dayOfIso('2026-10-05')?.getTime()).toBe(day.getTime());
    expect(dayOfIso('2026-10-05', '14:30')?.getHours()).toBe(14);
    expect(dayOfIso('5.10.2026')).toBeNull();
    expect(dayOfIso(null)).toBeNull();
  });
});
