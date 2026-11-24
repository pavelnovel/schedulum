/**
 * The narrow boundary between Schedulum and a calendar. Everything above it
 * (availability, booking rules, the UI) is calendar-agnostic; Google and the
 * development fake both live below it.
 */
import type { Interval } from './availability';
import { isAdvertisingEventId } from './tokens';

export type Booking = {
  id: string;
  start: Date;
  end: Date;
  /** The topic's id, or '' when the visitor picked none. */
  routeId: string;
  guestName: string;
  guestEmail: string;
  meetUrl?: string;
  cancelled: boolean;
};

export type NewBooking = {
  id: string;
  start: Date;
  end: Date;
  summary: string;
  description: string;
  routeId?: string;
  guestName: string;
  guestEmail: string;
  /** Keyed hash of the guest's email, so their bookings can be counted without storing the address in a query. */
  guestKey: string;
};

export interface Calendar {
  /** Busy blocks across every calendar that should block booking. */
  busy(from: Date, to: Date): Promise<Interval[]>;
  /** Schedulum's own bookings in range, optionally only one guest's. */
  bookings(from: Date, to: Date, guestKey?: string): Promise<Booking[]>;
  create(booking: NewBooking): Promise<Booking>;
  get(id: string): Promise<Booking | null>;
  move(id: string, start: Date, end: Date): Promise<Booking>;
  cancel(id: string): Promise<void>;
}

export type CalendarErrorKind = 'config' | 'auth' | 'not_found' | 'upstream';

export class CalendarError extends Error {
  constructor(
    public kind: CalendarErrorKind,
    message: string
  ) {
    super(message);
    this.name = 'CalendarError';
  }
}

export function withAdvertisingCalendar(personal: Calendar, advertising?: Calendar): Calendar {
  function calendarForEvent(id: string): Calendar {
    if (!isAdvertisingEventId(id)) return personal;
    if (!advertising) throw new CalendarError('config', 'The advertising organizer’s calendar is not connected.');
    return advertising;
  }

  return {
    async busy(from, to) {
      if (!advertising) return personal.busy(from, to);
      return (await Promise.all([personal.busy(from, to), advertising.busy(from, to)])).flat();
    },
    async bookings(from, to, guestKey) {
      if (!advertising) return personal.bookings(from, to, guestKey);
      return (await Promise.all([personal.bookings(from, to, guestKey), advertising.bookings(from, to, guestKey)])).flat();
    },
    create: async (booking) => calendarForEvent(booking.id).create(booking),
    get: async (id) => calendarForEvent(id).get(id),
    move: async (id, start, end) => calendarForEvent(id).move(id, start, end),
    cancel: async (id) => calendarForEvent(id).cancel(id),
  };
}
