/**
 * An in-memory calendar for development and tests. Busy blocks are derived
 * from the date, so the same day always looks the same, and bookings live
 * until the process restarts.
 */
import type { Interval } from './availability';
import { CalendarError, type Booking, type Calendar } from './calendar';
import { pad, zonedToUtc } from './tz';

type Stored = Booking & { guestKey: string };

export function fakeCalendar(timeZone: string): Calendar {
  const store = new Map<string, Stored>();

  function seededBusy(from: Date, to: Date): Interval[] {
    const blocks: Interval[] = [];
    const day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() - 1));
    while (day.getTime() <= to.getTime() + 86_400_000) {
      const y = day.getUTCFullYear();
      const m = day.getUTCMonth() + 1;
      const d = day.getUTCDate();
      const seed = (y * 372 + m * 31 + d) % 97;
      const at = (h: number, min = 0) => zonedToUtc(y, m, d, h, min, timeZone).getTime();

      // Lunch most days, plus one or two meetings that move around.
      if (seed % 5 !== 0) blocks.push({ start: at(12, 30), end: at(13, 15) });
      blocks.push({ start: at(10 + (seed % 4)), end: at(10 + (seed % 4), 45) });
      if (seed % 3 === 0) blocks.push({ start: at(14, 30), end: at(16) });
      if (seed % 11 === 0) blocks.push({ start: at(9), end: at(18) });

      day.setUTCDate(day.getUTCDate() + 1);
    }
    return blocks.filter((b) => b.end > from.getTime() && b.start < to.getTime());
  }

  const live = () => [...store.values()].filter((b) => !b.cancelled);

  return {
    async busy(from, to) {
      const mine = live()
        .filter((b) => b.end.getTime() > from.getTime() && b.start.getTime() < to.getTime())
        .map((b) => ({ start: b.start.getTime(), end: b.end.getTime() }));
      return [...seededBusy(from, to), ...mine];
    },

    async bookings(from, to, guestKey) {
      return live().filter(
        (b) =>
          b.end.getTime() > from.getTime() &&
          b.start.getTime() < to.getTime() &&
          (guestKey === undefined || b.guestKey === guestKey)
      );
    },

    async create(booking) {
      if (store.has(booking.id)) throw new CalendarError('upstream', 'duplicate id');
      const meet = `https://meet.google.com/fak-${booking.id.slice(0, 4)}-${pad(booking.start.getUTCMinutes())}x`;
      const stored: Stored = {
        id: booking.id,
        start: booking.start,
        end: booking.end,
        routeId: booking.routeId ?? '',
        guestName: booking.guestName,
        guestEmail: booking.guestEmail,
        guestKey: booking.guestKey,
        meetUrl: meet,
        cancelled: false,
      };
      store.set(booking.id, stored);
      return { ...stored };
    },

    async get(id) {
      const b = store.get(id);
      return b ? { ...b } : null;
    },

    async move(id, start, end) {
      const b = store.get(id);
      if (!b || b.cancelled) throw new CalendarError('not_found', id);
      b.start = start;
      b.end = end;
      return { ...b };
    },

    async cancel(id) {
      const b = store.get(id);
      if (!b) throw new CalendarError('not_found', id);
      b.cancelled = true;
    },
  };
}
