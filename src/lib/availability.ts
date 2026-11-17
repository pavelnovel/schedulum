/**
 * Turns working hours plus a calendar's busy blocks into bookable start
 * times. Pure: the caller supplies `now`, the busy blocks, and the per-day
 * booking counts, which is what makes this testable without a calendar.
 */
import type { Availability, Weekday } from '../config';
import { dateKey, pad, zonedToUtc } from './tz';

/** Epoch milliseconds, half-open: [start, end). */
export type Interval = { start: number; end: number };

const DAY_NAMES: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MINUTE = 60_000;

export type SlotInput = {
  now: Date;
  minutes: number;
  rules: Availability;
  busy: Interval[];
  /** Schedulum bookings already on each host-local date, keyed `YYYY-MM-DD`. */
  bookedPerDay?: Map<string, number>;
};

export function computeSlots({ now, minutes, rules, busy, bookedPerDay }: SlotInput): Date[] {
  const tz = rules.timezone;
  const earliest = now.getTime() + rules.minNoticeHours * 60 * MINUTE;
  const latest = now.getTime() + rules.horizonDays * 24 * 60 * MINUTE;
  const buffer = rules.bufferMinutes * MINUTE;
  const length = minutes * MINUTE;
  const blackout = new Set(rules.blackoutDates);
  const sorted = [...busy].sort((a, b) => a.start - b.start);

  // Walk host-local calendar dates. UTC date arithmetic is safe here because
  // only the year/month/day labels are used, never the instant.
  const [y, m, d] = dateKey(now, tz).split('-').map(Number);
  const slots: Date[] = [];

  for (let i = 0; i <= rules.horizonDays; i++) {
    const day = new Date(Date.UTC(y, m - 1, d + i));
    const key = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
    if (blackout.has(key)) continue;

    const windows = rules.weekly[DAY_NAMES[day.getUTCDay()]] ?? [];
    if ((bookedPerDay?.get(key) ?? 0) >= rules.maxPerDay) continue;

    for (const [from, to] of windows) {
      const [fh, fm] = from.split(':').map(Number);
      const [th, tm] = to.split(':').map(Number);
      const open = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), fh, fm, tz).getTime();
      const close = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), th, tm, tz).getTime();

      for (let t = open; t + length <= close; t += rules.stepMinutes * MINUTE) {
        if (t < earliest || t > latest) continue;
        if (overlaps(sorted, t - buffer, t + length + buffer)) continue;
        slots.push(new Date(t));
      }
    }
  }

  return slots;
}

function overlaps(sorted: Interval[], start: number, end: number): boolean {
  for (const b of sorted) {
    if (b.start >= end) return false;
    if (b.end > start) return true;
  }
  return false;
}

/**
 * Removes one interval from a set of busy blocks. Used when a guest
 * reschedules: their own meeting must not block the times next to it.
 * Free/busy merges adjacent blocks, so this cuts rather than filters.
 */
export function subtract(busy: Interval[], cut: Interval): Interval[] {
  const out: Interval[] = [];
  for (const b of busy) {
    if (b.end <= cut.start || b.start >= cut.end) {
      out.push(b);
      continue;
    }
    if (b.start < cut.start) out.push({ start: b.start, end: cut.start });
    if (b.end > cut.end) out.push({ start: cut.end, end: b.end });
  }
  return out;
}

/** True when `start` is one of the slots the rules would offer right now. */
export function isOffered(start: Date, input: SlotInput): boolean {
  return computeSlots(input).some((slot) => slot.getTime() === start.getTime());
}
