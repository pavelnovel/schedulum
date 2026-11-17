/**
 * Google Calendar over plain fetch — the Workers runtime has no Node SDK,
 * and five endpoints don't justify one.
 *
 * Auth is a single long-lived refresh token for Pavel's account, minted once
 * by `npm run connect-google` and stored as a Cloudflare secret. Access
 * tokens are exchanged on demand and cached for the life of the isolate.
 */
import type { Interval } from './availability';
import { CalendarError, type Booking, type Calendar, type NewBooking } from './calendar';

const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export type GoogleCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Calendar IDs whose events block booking. Bookings are always written to `primary`. */
  busyCalendars: string[];
};

type Cached = { token: string; expires: number };
const tokenCache = new Map<string, Cached>();

type GoogleEvent = {
  id: string;
  status?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  hangoutLink?: string;
  attendees?: { email: string; displayName?: string; self?: boolean; organizer?: boolean }[];
  extendedProperties?: { private?: Record<string, string> };
};

/** An access token for the refresh token, shared by the calendar and Gmail. */
export async function googleAccessToken(
  creds: Pick<GoogleCredentials, 'clientId' | 'clientSecret' | 'refreshToken'>,
  fetcher: typeof fetch = fetch
): Promise<string> {
  const cached = tokenCache.get(creds.refreshToken);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;

  const res = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    // invalid_grant means the refresh token was revoked or expired — the
    // fix is re-running connect-google, so say that instead of a status code.
    const body = await res.text();
    throw new CalendarError('auth', `Google refused the refresh token (${res.status}): ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(creds.refreshToken, { token: json.access_token, expires: Date.now() + json.expires_in * 1000 });
  return json.access_token;
}

export function googleCalendar(creds: GoogleCredentials, fetcher: typeof fetch = fetch): Calendar {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetcher(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await googleAccessToken(creds, fetcher)}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 || res.status === 410) throw new CalendarError('not_found', `${method} ${path}: ${res.status}`);
    if (res.status === 401 || res.status === 403) {
      throw new CalendarError('auth', `${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    if (!res.ok) throw new CalendarError('upstream', `${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    async busy(from, to) {
      const json = await call<{
        calendars: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }>;
      }>('POST', '/freeBusy', {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: creds.busyCalendars.map((id) => ({ id })),
      });

      const blocks: Interval[] = [];
      for (const [id, cal] of Object.entries(json.calendars)) {
        // A calendar Google can't read must fail closed. Treating it as
        // empty would offer times that are actually taken.
        if (cal.errors?.length) {
          throw new CalendarError('upstream', `free/busy for ${id}: ${cal.errors.map((e) => e.reason).join(', ')}`);
        }
        for (const b of cal.busy ?? []) blocks.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
      }
      return blocks;
    },

    async bookings(from, to, guestKey) {
      const params = new URLSearchParams({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: 'true',
        maxResults: '250',
      });
      params.append('privateExtendedProperty', 'schedulum=1');
      if (guestKey) params.append('privateExtendedProperty', `guest=${guestKey}`);
      const json = await call<{ items?: GoogleEvent[] }>('GET', `/calendars/primary/events?${params}`);
      return (json.items ?? []).map(toBooking).filter((b): b is Booking => b !== null && !b.cancelled);
    },

    async create(booking: NewBooking) {
      const event = await call<GoogleEvent>(
        'POST',
        '/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all',
        {
          id: booking.id,
          summary: booking.summary,
          description: booking.description,
          start: { dateTime: booking.start.toISOString() },
          end: { dateTime: booking.end.toISOString() },
          attendees: [{ email: booking.guestEmail, displayName: booking.guestName }],
          conferenceData: {
            createRequest: { requestId: booking.id, conferenceSolutionKey: { type: 'hangoutsMeet' } },
          },
          guestsCanInviteOthers: true,
          extendedProperties: {
            private: { schedulum: '1', ...(booking.routeId && { route: booking.routeId }), guest: booking.guestKey },
          },
        }
      );
      const result = toBooking(event);
      if (!result) throw new CalendarError('upstream', 'Google returned an event without times');
      return result;
    },

    async get(id) {
      try {
        const event = await call<GoogleEvent>('GET', `/calendars/primary/events/${encodeURIComponent(id)}`);
        // Only events Schedulum made are manageable through Schedulum.
        if (event.extendedProperties?.private?.schedulum !== '1') return null;
        return toBooking(event);
      } catch (err) {
        if (err instanceof CalendarError && err.kind === 'not_found') return null;
        throw err;
      }
    },

    async move(id, start, end) {
      const event = await call<GoogleEvent>(
        'PATCH',
        `/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=all`,
        { start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } }
      );
      const result = toBooking(event);
      if (!result) throw new CalendarError('upstream', 'Google returned an event without times');
      return result;
    },

    async cancel(id) {
      await call<void>('DELETE', `/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=all`);
    },
  };
}

function toBooking(event: GoogleEvent): Booking | null {
  if (!event.start?.dateTime || !event.end?.dateTime) return null;
  const guest = event.attendees?.find((a) => !a.self && !a.organizer);
  return {
    id: event.id,
    start: new Date(event.start.dateTime),
    end: new Date(event.end.dateTime),
    routeId: event.extendedProperties?.private?.route ?? '',
    guestName: guest?.displayName ?? '',
    guestEmail: guest?.email ?? '',
    meetUrl: event.hangoutLink,
    cancelled: event.status === 'cancelled',
  };
}
