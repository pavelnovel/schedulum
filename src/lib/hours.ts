/**
 * The visitor's own working hours: which of the host's open slots fall
 * inside them on the visitor's clock. Pure, so the booking page and the
 * tests share it.
 */
import { dateKey, wallClock } from './tz';

/** Whole hours on the visitor's clock: a meeting starts at or after `from` and ends by `to`. */
export type Hours = { from: number; to: number };

export function withinHours(start: Date, minutes: number, timeZone: string, hours: Hours): boolean {
  const end = new Date(start.getTime() + minutes * 60_000);
  const s = wallClock(start, timeZone);
  const e = wallClock(end, timeZone);
  const sameDay = dateKey(start, timeZone) === dateKey(end, timeZone);
  const startMinute = s.hour * 60 + s.minute;
  const endMinute = (sameDay ? 0 : 24 * 60) + e.hour * 60 + e.minute;
  return startMinute >= hours.from * 60 && endMinute <= hours.to * 60;
}
