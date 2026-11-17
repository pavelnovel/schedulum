/**
 * What the time zone notice above the calendar says. Pure: the booking page
 * renders the result, and the tests pin every state.
 *
 * It names a time zone ("Eastern Time"), never a place. The visitor's device
 * zone drives the times. Cloudflare's guess at the zone from the IP address
 * only offers a one-click switch when it disagrees with the device, as on a
 * VPN, and stands in when the device gives none.
 */
import { type Hours } from './hours';
import { offsetMinutes } from './tz';

export type Visitor = { timeZone?: string };

/**
 * Where the current zone came from: the device, the visitor's own pick,
 * the IP guess because the device gave none, or the host's zone because
 * nothing else was available.
 */
export type ZoneSource = 'device' | 'chosen' | 'ip' | 'host';

export type FitInput = {
  zone: string;
  source: ZoneSource;
  deviceZone: string | null;
  visitor: Visitor | null;
  hours: Hours;
  allHours: boolean;
  /** Rescheduling a booking that is itself outside the visitor's hours. */
  bookedOutside?: boolean;
  /** Open slots inside and outside the visitor's hours, or null while loading. */
  counts: { inside: number; outside: number } | null;
  /** The page can take a note, so the visitor can write when nothing works. */
  canNote: boolean;
  now: Date;
  locale?: string;
};

/** A sentence with exactly one zone token, where the page puts the zone picker. */
export type Piece = string | { zone: true };

export type Fit = {
  text: Piece[];
  toggle?: { label: string; showAll: boolean };
  /** Nothing falls in the visitor's hours, so every time shows and a note is the way on. */
  fullSchedule: boolean;
  correction?: { zone: string; label: string };
};

const Z = { zone: true } as const;

// Browsers still report some zones by their old names.
const RENAMED: Record<string, string> = {
  Asmera: 'Asmara',
  Calcutta: 'Kolkata',
  Enderbury: 'Kanton',
  Faeroe: 'Faroe',
  Godthab: 'Nuuk',
  Katmandu: 'Kathmandu',
  Kiev: 'Kyiv',
  Ponape: 'Pohnpei',
  Rangoon: 'Yangon',
  Saigon: 'Ho Chi Minh City',
  Truk: 'Chuuk',
};

/** The zone's city, for the full list of zones to pick from. */
export const cityOf = (tz: string) => {
  const city = tz.split('/').pop()!.replace(/_/g, ' ');
  return RENAMED[city] ?? city;
};

/** `GMT+9`, `GMT+5:30`, `GMT-4`, `GMT+0`. */
export function offsetLabel(tz: string, at: Date): string {
  const m = offsetMinutes(at, tz);
  const sign = m < 0 ? '-' : '+';
  const abs = Math.abs(m);
  const h = Math.floor(abs / 60);
  const min = abs % 60;
  return `GMT${sign}${h}${min ? `:${String(min).padStart(2, '0')}` : ''}`;
}

/** `Tokyo (GMT+9)`: an entry in the full list of zones. */
export const zoneLabel = (tz: string, at: Date) => `${cityOf(tz)} (${offsetLabel(tz, at)})`;

// How people say these, where the browser's name reads stiffly.
const SPOKEN: Record<string, string> = { 'United Kingdom Time': 'UK Time' };

/** `Eastern Time`, `Central European Time`: the zone without a place. Falls back to the offset. */
export function genericName(tz: string, at: Date, locale?: string): string {
  try {
    const name = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'longGeneric' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    if (name && !/^(GMT|UTC)/.test(name)) return SPOKEN[name] ?? name;
  } catch {
    // An engine without longGeneric gets the offset.
  }
  return offsetLabel(tz, at);
}

/**
 * `Eastern Time`, as the notice names the visitor's zone. No offset beside a
 * name: it would be today's, and wrong for meetings after the clocks change.
 */
export const zoneName = genericName;

/** A wall-clock time in the visitor's style: `9 AM` or `09:00`. */
export function clockLabel(hour: number, minute: number, locale?: string): string {
  const twentyFour = /h2[34]/.test(new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle ?? '');
  const opts: Intl.DateTimeFormatOptions = twentyFour
    ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }
    : { hour: 'numeric', minute: minute ? '2-digit' : undefined, timeZone: 'UTC' };
  return new Intl.DateTimeFormat(locale, opts).format(new Date(Date.UTC(2026, 0, 1, hour % 24, minute)));
}

/** Zones agree when they keep the same clock now; ids differ for aliases and neighbours. */
const sameClock = (a: string, b: string, at: Date) => offsetMinutes(at, a) === offsetMinutes(at, b);

export function fit(input: FitInput): Fit {
  const { source, deviceZone, visitor, hours, allHours, counts, canNote, now, locale } = input;
  const from = clockLabel(hours.from, 0, locale);
  const to = clockLabel(hours.to, 0, locale);
  const hrs = `${from} to ${to}`;

  if (source === 'host') {
    return { text: ['I couldn’t tell your time zone, so these times are in mine. Pick yours: ', Z], fullSchedule: false };
  }

  // The connection's zone is worth a word only when it keeps a different clock from the device.
  const other = source === 'device' && deviceZone && visitor?.timeZone && !sameClock(visitor.timeZone, deviceZone, now) ? visitor.timeZone : null;
  const correction = other ? { zone: other, label: zoneName(other, now, locale) } : undefined;

  const own = source === 'device';
  const prefix = source === 'ip' ? 'I couldn’t read your device’s time zone, so I’m going by your connection. ' : '';

  if (!counts || counts.outside === 0) {
    const text: Piece[] = own ? ['Times are in your time zone, ', Z, '.'] : [prefix + 'Showing times in ', Z, '.'];
    return { text, fullSchedule: false, correction };
  }

  if (counts.inside === 0) {
    const tail = `, so here’s my full schedule. I know these are outside your working hours.${canNote ? ' If none of them work, send me a note and we’ll find a time.' : ''}`;
    const text: Piece[] = own
      ? ['You seem to be on ', Z, `. None of my open times fall between ${from} and ${to} for you${tail}`]
      : [prefix + `None of my open times fall between ${from} and ${to} in `, Z, tail];
    return { text, fullSchedule: true, correction };
  }

  if (allHours) {
    const text: Piece[] = input.bookedOutside
      ? [`You booked outside ${hrs}, so I’m showing every time I have, in `, Z, '.']
      : ['Showing every time I have, in ', Z, '.'];
    return { text, toggle: { label: `Show only ${hrs}`, showAll: false }, fullSchedule: false, correction };
  }

  const text: Piece[] = own ? ['You seem to be on ', Z, `, so I’m showing times from ${hrs}.`] : [prefix + `Showing times from ${hrs} in `, Z, '.'];
  return { text, toggle: { label: 'Show all times', showAll: true }, fullSchedule: false, correction };
}

/** The notice as plain text with the zone named in place, as a visitor reads it. */
export function fitText(f: Fit, zone: string, now: Date, locale?: string): string {
  return f.text.map((p) => (typeof p === 'string' ? p : zoneName(zone, now, locale))).join('');
}
