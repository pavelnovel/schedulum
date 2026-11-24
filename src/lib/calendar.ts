/**
 * The narrow boundary between Schedulum and a calendar. Everything above it
 * (availability, booking rules, the UI) is calendar-agnostic; Google and the
 * development fake both live below it.
 */
import type { Interval } from './availability';

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
  /** Additional invite for the host's work account. */
  hostInviteEmail?: string;
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
