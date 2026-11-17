import { describe, expect, it } from 'vitest';
import { withinHours } from '../src/lib/hours';

const day = { from: 9, to: 19 };

describe('withinHours', () => {
  it('reads the slot on the visitor’s clock, not the host’s', () => {
    // 10:00 in New York on a Monday is 23:00 in Tokyo.
    const slot = new Date('2026-10-26T14:00:00Z');
    expect(withinHours(slot, 30, 'America/New_York', day)).toBe(true);
    expect(withinHours(slot, 30, 'Asia/Tokyo', day)).toBe(false);
  });

  it('needs the whole meeting inside the hours', () => {
    // 18:30 London ends at 19:00: in. 18:45 would end at 19:15: out.
    expect(withinHours(new Date('2026-10-26T18:30:00Z'), 30, 'Europe/London', day)).toBe(true);
    expect(withinHours(new Date('2026-10-26T18:45:00Z'), 30, 'Europe/London', day)).toBe(false);
    expect(withinHours(new Date('2026-10-26T09:00:00Z'), 30, 'Europe/London', day)).toBe(true);
    expect(withinHours(new Date('2026-10-26T08:30:00Z'), 30, 'Europe/London', day)).toBe(false);
  });

  it('never counts a meeting that runs past midnight', () => {
    const lateNight = new Date('2026-10-26T14:45:00Z'); // 23:45 in Tokyo
    expect(withinHours(lateNight, 30, 'Asia/Tokyo', { from: 0, to: 24 })).toBe(false);
    expect(withinHours(new Date('2026-10-26T14:00:00Z'), 30, 'Asia/Tokyo', { from: 0, to: 24 })).toBe(true);
  });

  it('handles half-hour offsets', () => {
    // 10:00 New York is 19:30 in Kolkata.
    expect(withinHours(new Date('2026-10-26T14:00:00Z'), 30, 'Asia/Kolkata', day)).toBe(false);
    expect(withinHours(new Date('2026-10-26T13:00:00Z'), 30, 'Asia/Kolkata', day)).toBe(true);
  });
});
