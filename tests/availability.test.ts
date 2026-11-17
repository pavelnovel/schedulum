import { describe, expect, it } from 'vitest';
import type { Availability } from '../src/config';
import { computeSlots, subtract } from '../src/lib/availability';

const rules: Availability = {
  timezone: 'America/New_York',
  weekly: { mon: [['10:00', '12:00']], wed: [['13:00', '14:00']] },
  stepMinutes: 30,
  bufferMinutes: 10,
  minNoticeHours: 12,
  horizonDays: 14,
  maxPerDay: 2,
  blackoutDates: [],
};

// Friday 2026-10-16, 12:00 New York.
const now = new Date('2026-10-16T16:00:00Z');
const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

describe('computeSlots', () => {
  it('offers every step inside the weekly windows', () => {
    const slots = iso(computeSlots({ now, minutes: 30, rules, busy: [] }));
    expect(slots.slice(0, 5)).toEqual([
      '2026-10-19T14:00:00.000Z', // Mon 10:00 EDT
      '2026-10-19T14:30:00.000Z',
      '2026-10-19T15:00:00.000Z',
      '2026-10-19T15:30:00.000Z',
      '2026-10-21T17:00:00.000Z', // Wed 13:00
    ]);
  });

  it('does not let a meeting run past the window', () => {
    const slots = iso(computeSlots({ now, minutes: 60, rules, busy: [] }));
    expect(slots).toContain('2026-10-19T15:00:00.000Z'); // 11:00–12:00 fits
    expect(slots).not.toContain('2026-10-19T15:30:00.000Z'); // 11:30–12:30 does not
  });

  it('keeps the buffer clear on both sides of a busy block', () => {
    const busy = [{ start: Date.parse('2026-10-19T15:00:00Z'), end: Date.parse('2026-10-19T15:30:00Z') }];
    const slots = iso(computeSlots({ now, minutes: 30, rules, busy }));
    // 10:30–11:00 ends exactly at the busy start, but needs 10 clear minutes after.
    expect(slots).not.toContain('2026-10-19T14:30:00.000Z');
    expect(slots).not.toContain('2026-10-19T15:00:00.000Z');
    // 11:30 starts exactly at the busy end, but needs 10 clear minutes before.
    expect(slots).not.toContain('2026-10-19T15:30:00.000Z');
    expect(slots).toContain('2026-10-19T14:00:00.000Z');
  });

  it('respects minimum notice', () => {
    const sundayEvening = new Date('2026-10-19T00:00:00Z'); // Sun 20:00 EDT
    const slots = iso(computeSlots({ now: sundayEvening, minutes: 30, rules, busy: [] }));
    expect(slots[0]).toBe('2026-10-19T14:00:00.000Z'); // Mon 10:00 is 14h away: allowed at 12h notice
    const strict = computeSlots({ now: sundayEvening, minutes: 30, rules: { ...rules, minNoticeHours: 15 }, busy: [] });
    expect(strict[0].toISOString()).toBe('2026-10-19T15:00:00.000Z'); // 10:00 and 10:30 are too soon
  });

  it('stops at the horizon', () => {
    const slots = computeSlots({ now, minutes: 30, rules: { ...rules, horizonDays: 4 }, busy: [] });
    expect(slots.every((s) => s.getTime() <= now.getTime() + 4 * 86_400_000)).toBe(true);
    expect(iso(slots)).not.toContain('2026-10-21T17:00:00.000Z');
  });

  it('skips blackout dates and days at their cap', () => {
    const blackout = computeSlots({ now, minutes: 30, rules: { ...rules, blackoutDates: ['2026-10-19'] }, busy: [] });
    expect(iso(blackout).some((s) => s.startsWith('2026-10-19'))).toBe(false);

    const capped = computeSlots({ now, minutes: 30, rules, busy: [], bookedPerDay: new Map([['2026-10-21', 2]]) });
    expect(iso(capped).some((s) => s.startsWith('2026-10-21'))).toBe(false);
    expect(iso(capped).some((s) => s.startsWith('2026-10-19'))).toBe(true);
  });

  it('keeps windows in host wall time across the DST change', () => {
    // Monday 2026-11-02 is the first Monday on EST: 10:00 New York is 15:00 UTC.
    const slots = iso(computeSlots({ now, minutes: 30, rules: { ...rules, horizonDays: 20 }, busy: [] }));
    expect(slots).toContain('2026-11-02T15:00:00.000Z');
    expect(slots).not.toContain('2026-11-02T14:00:00.000Z');
  });
});

describe('subtract', () => {
  it('cuts a hole out of a merged block', () => {
    expect(subtract([{ start: 0, end: 100 }], { start: 40, end: 60 })).toEqual([
      { start: 0, end: 40 },
      { start: 60, end: 100 },
    ]);
  });

  it('removes an exact match and leaves others alone', () => {
    expect(
      subtract(
        [
          { start: 0, end: 10 },
          { start: 40, end: 60 },
        ],
        { start: 40, end: 60 }
      )
    ).toEqual([{ start: 0, end: 10 }]);
  });
});
