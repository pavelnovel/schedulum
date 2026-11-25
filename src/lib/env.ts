/**
 * Reads Cloudflare bindings into the pieces the booking service needs.
 * Secrets come from `wrangler secret put` in production and from
 * `.dev.vars` locally.
 */
import { availability } from '../config';
import { CalendarError, withAdvertisingCalendar, type Calendar } from './calendar';
import { fakeCalendar } from './fake';
import { googleCalendar } from './google';
import { fakeMailer, gmailMailer, type Mailer } from './note';
import { syncStore, withSyncedBusy, type Store } from './synced';

export type Env = {
  BOOKING_COORDINATOR: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
  CALENDAR_MODE?: 'google' | 'fake';
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  /** Comma-separated calendar IDs that block booking. Defaults to `primary`. */
  BUSY_CALENDARS?: string;
  SIGNING_SECRET?: string;
  /** Origin used in manage links, e.g. `https://meet.pavelnovel.com`. */
  PUBLIC_URL?: string;
  /** OAuth credentials for the Google account that organizes spoiled NYC advertising meetings. */
  ADVERTISING_GOOGLE_CLIENT_ID?: string;
  ADVERTISING_GOOGLE_CLIENT_SECRET?: string;
  ADVERTISING_GOOGLE_REFRESH_TOKEN?: string;
  /** Optional: POSTed `{ text }` on every booking, reschedule, and cancellation. */
  NOTIFY_WEBHOOK_URL?: string;
  /** Cloudflare Turnstile secret. When set, every new booking must pass the spam check. */
  TURNSTILE_SECRET_KEY?: string;
  /** Shared with the push job. Without it, PUT /api/busy is off and pushed busy times are ignored. */
  BUSY_SYNC_SECRET?: string;
  /** KV namespace holding the busy times the push job sends. */
  SYNCED_BUSY?: Store;
};

let fake: Calendar | undefined;
let fakeAdvertising: Calendar | undefined;
let fakeMail: ReturnType<typeof fakeMailer> | undefined;

export const localBuild = import.meta.env.DEV || import.meta.env.MODE === 'demo';

export function calendarMode(env: Env): 'fake' | 'google' {
  const mode = env.CALENDAR_MODE ?? (localBuild ? 'fake' : 'google');
  if (mode !== 'fake' && mode !== 'google') throw new CalendarError('config', 'Unknown CALENDAR_MODE.');
  return mode;
}

export function calendarFor(env: Env): Calendar {
  const isFake = calendarMode(env) === 'fake';
  const personal = isFake ? (fake ??= fakeCalendar(availability.timezone)) : google(env);
  const advertising = isFake ? (fakeAdvertising ??= fakeCalendar(availability.timezone)) : googleAdvertising(env);
  const calendar = withAdvertisingCalendar(personal, advertising);
  const store = syncStore(env);
  return store ? withSyncedBusy(calendar, store) : calendar;
}

/** Where visitors' notes go: the host's Gmail, or nowhere in development. */
export function mailerFor(env: Env): Mailer {
  return calendarMode(env) === 'fake' ? (fakeMail ??= fakeMailer()) : gmailMailer(googleCreds(env));
}

function googleCreds(env: Env) {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new CalendarError('config', 'Google credentials are not set. See SETUP.md.');
  }
  return { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, refreshToken: GOOGLE_REFRESH_TOKEN };
}

function google(env: Env): Calendar {
  return googleCalendar({
    ...googleCreds(env),
    busyCalendars: (env.BUSY_CALENDARS ?? 'primary')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  });
}

function googleAdvertising(env: Env): Calendar | undefined {
  const {
    ADVERTISING_GOOGLE_CLIENT_ID: clientId,
    ADVERTISING_GOOGLE_CLIENT_SECRET: clientSecret,
    ADVERTISING_GOOGLE_REFRESH_TOKEN: refreshToken,
  } = env;
  if (!clientId || !clientSecret || !refreshToken) return undefined;
  return googleCalendar({ clientId, clientSecret, refreshToken, busyCalendars: ['primary'] });
}

export function signingSecret(env: Env): string {
  if (!env.SIGNING_SECRET || env.SIGNING_SECRET.length < 32) {
    throw new CalendarError('config', 'SIGNING_SECRET must be set to at least 32 characters. See SETUP.md.');
  }
  return env.SIGNING_SECRET;
}

export function notifier(env: Env): (text: string) => Promise<void> {
  const url = env.NOTIFY_WEBHOOK_URL;
  return async (text) => {
    if (!url) return;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // A missed notification must never fail the booking it describes.
    }
  };
}
