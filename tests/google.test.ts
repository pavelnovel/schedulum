import { describe, expect, it } from 'vitest';
import { CalendarError } from '../src/lib/calendar';
import { googleCalendar } from '../src/lib/google';

type Call = { url: string; method: string; body?: any };

function fakeGoogle(handler: (call: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
    }
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const call = { url, method, body };
    calls.push(call);
    const { status = 200, json = {} } = handler(call);
    return new Response(status === 204 ? null : JSON.stringify(json), { status });
  }) as typeof fetch;
  return { fetcher, calls };
}

let n = 0;
const creds = () => ({ clientId: 'c', clientSecret: 's', refreshToken: `rt-${n++}`, busyCalendars: ['primary', 'work@x.com'] });

describe('googleCalendar', () => {
  it('merges free/busy across calendars', async () => {
    const { fetcher, calls } = fakeGoogle(() => ({
      json: {
        calendars: {
          primary: { busy: [{ start: '2026-10-19T14:00:00Z', end: '2026-10-19T15:00:00Z' }] },
          'work@x.com': { busy: [{ start: '2026-10-19T18:00:00Z', end: '2026-10-19T19:00:00Z' }] },
        },
      },
    }));
    const busy = await googleCalendar(creds(), fetcher).busy(new Date('2026-10-19T00:00:00Z'), new Date('2026-10-20T00:00:00Z'));
    expect(busy).toHaveLength(2);
    expect(calls[0].body.items).toEqual([{ id: 'primary' }, { id: 'work@x.com' }]);
  });

  it('fails closed when a busy calendar cannot be read', async () => {
    const { fetcher } = fakeGoogle(() => ({
      json: { calendars: { primary: { busy: [] }, 'work@x.com': { errors: [{ reason: 'notFound' }] } } },
    }));
    await expect(googleCalendar(creds(), fetcher).busy(new Date(), new Date())).rejects.toBeInstanceOf(CalendarError);
  });

  it('creates an event with the guest, a Meet link, and invites sent', async () => {
    const { fetcher, calls } = fakeGoogle((call) => ({
      json: {
        id: call.body.id,
        start: call.body.start,
        end: call.body.end,
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
        attendees: [{ email: 'pkonopl@gmail.com', self: true, organizer: true }, ...call.body.attendees],
        extendedProperties: call.body.extendedProperties,
      },
    }));
    const booking = await googleCalendar(creds(), fetcher).create({
      id: 'abc123def456',
      start: new Date('2026-10-19T14:00:00Z'),
      end: new Date('2026-10-19T14:30:00Z'),
      summary: 's',
      description: 'd',
      routeId: 'ai-systems',
      guestName: 'Ada',
      guestEmail: 'ada@example.com',
      guestKey: 'k',
    });

    expect(calls[0].url).toContain('conferenceDataVersion=1');
    expect(calls[0].url).toContain('sendUpdates=all');
    expect(calls[0].body.conferenceData.createRequest.conferenceSolutionKey.type).toBe('hangoutsMeet');
    expect(calls[0].body.extendedProperties.private).toEqual({ schedulum: '1', route: 'ai-systems', guest: 'k' });
    expect(booking).toMatchObject({ guestEmail: 'ada@example.com', guestName: 'Ada', meetUrl: 'https://meet.google.com/abc-defg-hij' });
  });

  it('leaves the topic off an event booked without one', async () => {
    const { fetcher, calls } = fakeGoogle((call) => ({
      json: { id: call.body.id, start: call.body.start, end: call.body.end, extendedProperties: call.body.extendedProperties },
    }));
    const booking = await googleCalendar(creds(), fetcher).create({
      id: 'abc123def457',
      start: new Date('2026-10-19T14:00:00Z'),
      end: new Date('2026-10-19T14:30:00Z'),
      summary: 's',
      description: 'd',
      guestName: 'Ada',
      guestEmail: 'ada@example.com',
      guestKey: 'k',
    });
    expect(calls[0].body.extendedProperties.private).toEqual({ schedulum: '1', guest: 'k' });
    expect(booking.routeId).toBe('');
  });

  it('refuses to manage events Schedulum did not create', async () => {
    const { fetcher } = fakeGoogle(() => ({
      json: { id: 'x', start: { dateTime: '2026-10-19T14:00:00Z' }, end: { dateTime: '2026-10-19T15:00:00Z' } },
    }));
    expect(await googleCalendar(creds(), fetcher).get('x')).toBeNull();
  });

  it('treats a missing event as null, not an error', async () => {
    const { fetcher } = fakeGoogle(() => ({ status: 404 }));
    expect(await googleCalendar(creds(), fetcher).get('gone')).toBeNull();
  });

  it('queries only Schedulum events, optionally for one guest', async () => {
    const { fetcher, calls } = fakeGoogle(() => ({ json: { items: [] } }));
    await googleCalendar(creds(), fetcher).bookings(new Date(), new Date(), 'guestkey');
    const url = new URL(calls[0].url);
    expect(url.searchParams.getAll('privateExtendedProperty')).toEqual(['schedulum=1', 'guest=guestkey']);
  });

  it('cancels with notifications to the guest', async () => {
    const { fetcher, calls } = fakeGoogle(() => ({ status: 204 }));
    await googleCalendar(creds(), fetcher).cancel('abc');
    expect(calls[0]).toMatchObject({ method: 'DELETE' });
    expect(calls[0].url).toContain('sendUpdates=all');
  });
});
