import { describe, expect, it } from 'vitest';
import { dateKey, offsetMinutes, wallClock, zonedToUtc } from '../src/lib/tz';

const NY = 'America/New_York';

describe('zonedToUtc', () => {
  it('converts winter wall time (EST, UTC-5)', () => {
    expect(zonedToUtc(2026, 1, 15, 10, 0, NY).toISOString()).toBe('2026-01-15T15:00:00.000Z');
  });

  it('converts summer wall time (EDT, UTC-4)', () => {
    expect(zonedToUtc(2026, 7, 15, 10, 0, NY).toISOString()).toBe('2026-07-15T14:00:00.000Z');
  });

  it('lands on the right side of spring-forward (2026-03-08)', () => {
    expect(zonedToUtc(2026, 3, 8, 1, 30, NY).toISOString()).toBe('2026-03-08T06:30:00.000Z');
    expect(zonedToUtc(2026, 3, 8, 10, 0, NY).toISOString()).toBe('2026-03-08T14:00:00.000Z');
  });

  it('lands on the right side of fall-back (2026-11-01)', () => {
    expect(zonedToUtc(2026, 11, 1, 10, 0, NY).toISOString()).toBe('2026-11-01T15:00:00.000Z');
  });

  it('handles zones ahead of UTC and half-hour offsets', () => {
    expect(zonedToUtc(2026, 5, 1, 9, 0, 'Asia/Kolkata').toISOString()).toBe('2026-05-01T03:30:00.000Z');
    expect(zonedToUtc(2026, 5, 1, 9, 0, 'Asia/Tokyo').toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('wallClock and dateKey', () => {
  it('reads the date in the zone, not in UTC', () => {
    const lateEvening = new Date('2026-10-20T02:30:00Z'); // 22:30 on the 19th in New York
    expect(dateKey(lateEvening, NY)).toBe('2026-10-19');
    expect(dateKey(lateEvening, 'UTC')).toBe('2026-10-20');
    expect(wallClock(lateEvening, NY)).toMatchObject({ hour: 22, minute: 30, weekday: 1 });
  });

  it('reports midnight as hour 0', () => {
    expect(wallClock(new Date('2026-10-20T04:00:00Z'), NY).hour).toBe(0);
  });

  it('measures offsets', () => {
    expect(offsetMinutes(new Date('2026-01-15T12:00:00Z'), NY)).toBe(-300);
    expect(offsetMinutes(new Date('2026-07-15T12:00:00Z'), NY)).toBe(-240);
  });
});
