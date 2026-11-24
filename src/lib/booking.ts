/**
 * The booking rules, independent of HTTP and of which calendar is
 * underneath. Every write re-derives availability from the calendar first:
 * a slot the visitor saw a minute ago is only bookable if it is still free.
 */
import { advertising, availability, findRoute, host, meeting, minutesFor, type Route } from '../config';
import { computeSlots, subtract, type Interval } from './availability';
import type { Booking, Calendar } from './calendar';
import { guestKey, newEventId, signId, verifyToken } from './tokens';
import { dateKey, isValidTimeZone } from './tz';

/** Upcoming Schedulum meetings one email address may hold at once. */
export const MAX_UPCOMING_PER_GUEST = 2;
const MINUTE = 60_000;

export type BookingFailure =
  | 'invalid'
  | 'slot_taken'
  | 'too_many'
  | 'not_found'
  | 'already_happened'
  | 'unverified';

export class BookingError extends Error {
  constructor(
    public code: BookingFailure,
    message: string
  ) {
    super(message);
    this.name = 'BookingError';
  }
}

export type Deps = {
  calendar: Calendar;
  secret: string;
  publicUrl: string;
  now?: () => Date;
  notify?: (text: string) => Promise<void>;
};

export async function listSlots(deps: Deps, minutes: number, exclude?: Booking): Promise<Date[]> {
  const now = deps.now?.() ?? new Date();
  const to = new Date(now.getTime() + (availability.horizonDays + 1) * 24 * 60 * MINUTE);

  // Bookings are read from a day back so a meeting earlier today still counts
  // toward today's cap.
  const dayAgo = new Date(now.getTime() - 24 * 60 * MINUTE);
  const [busyRaw, booked] = await Promise.all([deps.calendar.busy(now, to), deps.calendar.bookings(dayAgo, to)]);

  let busy: Interval[] = busyRaw;
  if (exclude) busy = subtract(busy, { start: exclude.start.getTime(), end: exclude.end.getTime() });

  const bookedPerDay = new Map<string, number>();
  for (const b of booked) {
    if (b.id === exclude?.id) continue;
    const key = dateKey(b.start, availability.timezone);
    bookedPerDay.set(key, (bookedPerDay.get(key) ?? 0) + 1);
  }

  return computeSlots({ now, minutes, rules: availability, busy, bookedPerDay });
}

export type BookingRequest = {
  /** The topic, if the visitor picked one. */
  routeId?: string;
  start: string;
  name: string;
  email: string;
  note?: string;
  timeZone?: string;
};

export type Confirmation = {
  start: string;
  end: string;
  routeId?: string;
  meetUrl?: string;
  manageUrl: string;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validate(req: BookingRequest): {
  route?: Route;
  start: Date;
  name: string;
  email: string;
  note: string;
  timeZone?: string;
} {
  // The topic is optional, so one that no longer exists (from a page cached
  // before it was removed) books with no topic rather than failing.
  const route = findRoute(req.routeId);

  const start = new Date(req.start);
  if (Number.isNaN(start.getTime())) throw new BookingError('invalid', 'Pick a time.');

  const name = (req.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 100) throw new BookingError('invalid', 'Enter your name.');

  const email = (req.email ?? '').trim();
  if (email.length > 254 || !EMAIL.test(email)) throw new BookingError('invalid', 'Enter a valid email address.');

  const note = (req.note ?? '').trim();
  if (note.length > 1500) throw new BookingError('invalid', 'Keep the note under 1,500 characters.');

  if (req.timeZone && !isValidTimeZone(req.timeZone)) throw new BookingError('invalid', 'Unknown timezone.');

  return { route, start, name, email, note, timeZone: req.timeZone || undefined };
}

export async function book(deps: Deps, req: BookingRequest): Promise<Confirmation> {
  const { route, start, name, email, note, timeZone } = validate(req);

  const minutes = minutesFor(route);
  const slots = await listSlots(deps, minutes);
  if (!slots.some((s) => s.getTime() === start.getTime())) {
    throw new BookingError('slot_taken', 'That time was just taken. Pick another.');
  }

  const key = await guestKey(email, deps.secret);
  const now = deps.now?.() ?? new Date();
  const horizon = new Date(now.getTime() + 400 * 24 * 60 * MINUTE);
  const upcoming = await deps.calendar.bookings(now, horizon, key);
  if (upcoming.length >= MAX_UPCOMING_PER_GUEST) {
    throw new BookingError(
      'too_many',
      `You already have ${upcoming.length} upcoming conversations booked. Use the link in one of those invites to change it.`
    );
  }

  const id = newEventId();
  const manageUrl = `${deps.publicUrl}/manage/${await signId(id, deps.secret)}`;
  const end = new Date(start.getTime() + minutes * MINUTE);
  const names = `${name} × ${host.firstName}`;

  const booking = await deps.calendar.create({
    id,
    start,
    end,
    summary: route?.id === advertising.route.id ? `${route.label} · ${names}` : names,
    description: describe(route, name, note, manageUrl, timeZone),
    routeId: route?.id,
    guestName: name,
    guestEmail: email,
    guestKey: key,
  });

  if (!(await keepsSlot(deps, booking)) && (await withdraw(deps, booking))) {
    throw new BookingError('slot_taken', 'That time was just taken. Pick another.');
  }

  await deps.notify?.(`New booking: ${[name, route?.label, formatForHost(start)].filter(Boolean).join(', ')}`);

  return {
    start: booking.start.toISOString(),
    end: booking.end.toISOString(),
    routeId: route?.id,
    meetUrl: booking.meetUrl,
    manageUrl,
  };
}

/**
 * The check before writing can't stop two visitors who pass it at the same
 * moment, so it runs again after writing. A new booking keeps its time only
 * if no other booking sits within the buffer around it. Each booking is
 * written before its own re-check reads, so of two racing bookings at least
 * one sees the other. At most one keeps the time, and sometimes neither
 * does: two lost bookings beat one double-booked hour.
 */
async function keepsSlot(deps: Deps, booking: Booking): Promise<boolean> {
  const buffer = availability.bufferMinutes * MINUTE;
  let nearby: Booking[];
  try {
    nearby = await deps.calendar.bookings(
      new Date(booking.start.getTime() - buffer),
      new Date(booking.end.getTime() + buffer)
    );
  } catch (err) {
    // The invite has already gone out, so keep the booking and ask Pavel to look.
    console.error('schedulum: could not re-check a new booking', err);
    await deps.notify?.(`Couldn’t check a new booking for overlaps: ${formatForHost(booking.start)}. Check your calendar.`);
    return true;
  }
  return nearby.every((b) => b.id === booking.id);
}

/** Deletes a booking that lost its slot. False if it couldn't, in which case the booking stands. */
async function withdraw(deps: Deps, booking: Booking): Promise<boolean> {
  try {
    await deps.calendar.cancel(booking.id);
    return true;
  } catch (err) {
    console.error('schedulum: could not withdraw an overlapping booking', err);
    await deps.notify?.(`Two bookings overlap at ${formatForHost(booking.start)}, including ${booking.guestName}’s. Check your calendar.`);
    return false;
  }
}

export function describe(route: Route | undefined, name: string, note: string, manageUrl: string, timeZone?: string): string {
  const lines: string[] = [];
  if (route) lines.push(`Topic: ${route.label}`, '');
  // The question they answered, so the answer reads in context.
  if (note) lines.push(route?.prompt ?? meeting.prompt, note, '');
  lines.push(`Need to reschedule or cancel? ${manageUrl}`, '');
  lines.push(`Booked by ${name} at ${new URL(manageUrl).host}${timeZone ? ` from ${timeZone}` : ''}`);
  return lines.join('\n');
}

function formatForHost(date: Date): string {
  return date.toLocaleString('en-US', {
    timeZone: availability.timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** A booking's own length, which a later change to the config doesn't alter. */
export const lengthOf = (booking: Booking) => Math.round((booking.end.getTime() - booking.start.getTime()) / MINUTE);

/**
 * Resolves a manage token to a live booking, or throws. `label` is the topic,
 * or "A conversation" when there was none or it has since been removed.
 */
export async function lookup(deps: Deps, token: string): Promise<{ booking: Booking; label: string }> {
  const id = await verifyToken(token, deps.secret);
  if (!id) throw new BookingError('not_found', 'This link isn’t valid.');
  const booking = await deps.calendar.get(id);
  if (!booking || booking.cancelled) throw new BookingError('not_found', 'This conversation was cancelled.');
  return { booking, label: findRoute(booking.routeId)?.label ?? 'A conversation' };
}

function assertUpcoming(deps: Deps, booking: Booking) {
  const now = deps.now?.() ?? new Date();
  if (booking.start.getTime() <= now.getTime()) {
    throw new BookingError('already_happened', 'This conversation has already started.');
  }
}

export async function reschedule(deps: Deps, token: string, startIso: string): Promise<Confirmation> {
  const { booking } = await lookup(deps, token);
  assertUpcoming(deps, booking);

  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) throw new BookingError('invalid', 'Pick a time.');

  const slots = await listSlots(deps, lengthOf(booking), booking);
  if (!slots.some((s) => s.getTime() === start.getTime())) {
    throw new BookingError('slot_taken', 'That time was just taken. Pick another.');
  }

  const end = new Date(start.getTime() + lengthOf(booking) * MINUTE);
  const moved = await deps.calendar.move(booking.id, start, end);
  await deps.notify?.(`Rescheduled: ${booking.guestName}, now ${formatForHost(start)} (was ${formatForHost(booking.start)})`);

  return {
    start: moved.start.toISOString(),
    end: moved.end.toISOString(),
    routeId: booking.routeId || undefined,
    meetUrl: moved.meetUrl,
    manageUrl: `${deps.publicUrl}/manage/${token}`,
  };
}

export async function cancel(deps: Deps, token: string): Promise<void> {
  const { booking } = await lookup(deps, token);
  assertUpcoming(deps, booking);
  await deps.calendar.cancel(booking.id);
  await deps.notify?.(`Cancelled: ${booking.guestName}, ${formatForHost(booking.start)}`);
}
