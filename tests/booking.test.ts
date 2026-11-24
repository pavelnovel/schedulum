import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advertising, meeting, minutesFor, routes, type Route } from '../src/config';
import { book, BookingError, cancel, listSlots, lookup, MAX_UPCOMING_PER_GUEST, reschedule, type Deps } from '../src/lib/booking';
import type { Calendar } from '../src/lib/calendar';
import { fakeCalendar } from '../src/lib/fake';
import { GET as slotsApi } from '../src/pages/api/slots';

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
// Friday 2026-10-16, 09:00 New York.
const NOW = new Date('2026-10-16T13:00:00Z');
const route = routes[0];

let calendar: Calendar;
let notes: string[];
let deps: Deps;

beforeEach(() => {
  calendar = fakeCalendar('America/New_York');
  notes = [];
  deps = {
    calendar,
    secret: SECRET,
    publicUrl: 'https://meet.example',
    now: () => NOW,
    notify: async (t) => void notes.push(t),
  };
});

async function firstSlot(): Promise<string> {
  return (await listSlots(deps, meeting.minutes))[0].toISOString();
}

const guest = { name: 'Ada Lovelace', email: 'ada@example.com', note: 'Analytical engines.' };

async function expectFailure(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(BookingError);
  await promise.catch((e: BookingError) => expect(e.code).toBe(code));
}

describe('book', () => {
  it('creates a calendar event and returns a manage link', async () => {
    const start = await firstSlot();
    const result = await book(deps, { routeId: route.id, start, ...guest });

    expect(result.start).toBe(start);
    expect(new Date(result.end).getTime() - new Date(start).getTime()).toBe(meeting.minutes * 60_000);
    expect(result.manageUrl).toMatch(/^https:\/\/meet\.example\/manage\/[0-9a-v]{26}\.[\w-]+$/);
    expect(result.meetUrl).toBeTruthy();
    expect(notes).toHaveLength(1);

    const { booking } = await lookup(deps, result.manageUrl.split('/manage/')[1]);
    expect(booking).toMatchObject({ guestName: 'Ada Lovelace', guestEmail: 'ada@example.com', routeId: route.id });
    expect(notes[0]).toContain(`, ${route.label}, `);
  });

  it('titles the event with just the two names', async () => {
    let summary = '';
    const create = calendar.create.bind(calendar);
    calendar.create = (b) => ((summary = b.summary), create(b));
    await book(deps, { routeId: route.id, start: await firstSlot(), ...guest });
    expect(summary).toBe('Ada Lovelace × Pavel');
  });

  it.each([
    [advertising.route.id, guest.email, 'host@work.example'],
    [advertising.route.id, 'HOST@work.example', undefined],
    [route.id, guest.email, undefined],
  ])('routes the additional invitation for %s and %s', async (routeId, email, expected) => {
    deps.advertisingInviteEmail = 'host@work.example';
    const create = calendar.create.bind(calendar);
    let hostInviteEmail: string | undefined;
    calendar.create = (booking) => {
      hostInviteEmail = booking.hostInviteEmail;
      return create(booking);
    };

    await book(deps, { ...guest, routeId, email, start: await firstSlot() });

    expect(hostInviteEmail).toBe(expected);
  });

  it('removes a booked slot from availability', async () => {
    const start = await firstSlot();
    await book(deps, { routeId: route.id, start, ...guest });
    expect((await listSlots(deps, meeting.minutes)).map((s) => s.toISOString())).not.toContain(start);
  });

  it('refuses a slot that is no longer free', async () => {
    const start = await firstSlot();
    await book(deps, { routeId: route.id, start, ...guest });
    await expectFailure(book(deps, { routeId: route.id, start, ...guest, email: 'other@example.com' }), 'slot_taken');
  });

  it('never leaves two bookings in a slot booked twice at once', async () => {
    const start = await firstSlot();
    const results = await Promise.allSettled([
      book(deps, { routeId: route.id, start, ...guest }),
      book(deps, { routeId: route.id, start, ...guest, email: 'grace@example.com' }),
    ]);
    const at = new Date(start);
    const kept = await calendar.bookings(at, new Date(at.getTime() + meeting.minutes * 60_000));
    expect(kept.length).toBeLessThanOrEqual(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(kept.length);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'slot_taken' });
    expect(notes).toHaveLength(kept.length);
  });

  // A booking that lands after this one's first check, which therefore can't see it.
  async function lateRival(start: Date, id = 'rival') {
    calendar.busy = async () => [];
    await calendar.create({
      id,
      start,
      end: new Date(start.getTime() + meeting.minutes * 60_000),
      summary: '',
      description: '',
      routeId: route.id,
      guestName: 'Grace',
      guestEmail: 'grace@example.com',
      guestKey: 'g',
    });
  }

  it('withdraws when another booking took the same time after the first check', async () => {
    const start = await firstSlot();
    const at = new Date(start);
    await lateRival(at);
    await expectFailure(book(deps, { routeId: route.id, start, ...guest }), 'slot_taken');
    expect((await calendar.bookings(at, new Date(at.getTime() + 60_000))).map((b) => b.id)).toEqual(['rival']);
  });

  it('withdraws when another booking took the buffer next to it', async () => {
    const start = await firstSlot();
    await lateRival(new Date(new Date(start).getTime() + meeting.minutes * 60_000));
    await expectFailure(book(deps, { routeId: route.id, start, ...guest }), 'slot_taken');
  });

  it('keeps the booking and alerts Pavel when the second check can’t run', async () => {
    const start = await firstSlot();
    const bookings = calendar.bookings.bind(calendar);
    // Only the check after writing reads from a future start without a guest key.
    calendar.bookings = async (from, to, key) => {
      if (key === undefined && from.getTime() > NOW.getTime()) throw new Error('Google is down');
      return bookings(from, to, key);
    };
    await book(deps, { routeId: route.id, start, ...guest });
    expect(notes.some((n) => n.startsWith('Couldn’t check a new booking for overlaps'))).toBe(true);
  });

  it('keeps the booking and alerts Pavel when it can’t withdraw', async () => {
    const start = await firstSlot();
    await lateRival(new Date(start));
    calendar.cancel = async () => {
      throw new Error('Google is down');
    };
    await book(deps, { routeId: route.id, start, ...guest });
    expect(notes.some((n) => n.startsWith('Two bookings overlap'))).toBe(true);
  });

  it('refuses a time that was never offered', async () => {
    await expectFailure(book(deps, { routeId: route.id, start: '2026-10-17T07:00:00Z', ...guest }), 'slot_taken');
  });

  it('caps upcoming bookings per guest, ignoring email case', async () => {
    const slots = (await listSlots(deps, meeting.minutes)).map((s) => s.toISOString());
    for (let i = 0; i < MAX_UPCOMING_PER_GUEST; i++) {
      await book(deps, { routeId: route.id, start: slots[i * 6], ...guest });
    }
    await expectFailure(
      book(deps, { routeId: route.id, start: slots[40], ...guest, email: 'ADA@example.com' }),
      'too_many'
    );
  });

  it('counts + aliases and Gmail dots as the same guest', async () => {
    const slots = (await listSlots(deps, meeting.minutes)).map((s) => s.toISOString());
    await book(deps, { routeId: route.id, start: slots[0], ...guest, email: 'ada.lovelace@gmail.com' });
    await book(deps, { routeId: route.id, start: slots[6], ...guest, email: 'adalovelace+2@gmail.com' });
    await expectFailure(
      book(deps, { routeId: route.id, start: slots[40], ...guest, email: 'Ada.Love.Lace+3@googlemail.com' }),
      'too_many'
    );
  });

  it('books with no topic, and treats a topic that no longer exists as none', async () => {
    let made: { description: string; routeId?: string } | undefined;
    const create = calendar.create.bind(calendar);
    calendar.create = (b) => ((made = b), create(b));

    const result = await book(deps, { start: await firstSlot(), ...guest });
    expect(result.routeId).toBeUndefined();
    expect(made?.routeId).toBeUndefined();
    expect(made?.description).not.toContain('Topic:');
    expect(made?.description).toContain(`${meeting.prompt}\nAnalytical engines.`);
    expect(notes[0]).toMatch(/^New booking: Ada Lovelace, \w{3}, /);

    const stale = await book(deps, { routeId: 'nope', start: (await listSlots(deps, meeting.minutes))[6].toISOString(), ...guest });
    expect(stale.routeId).toBeUndefined();
    const { label } = await lookup(deps, stale.manageUrl.split('/manage/')[1]);
    expect(label).toBe('A conversation');
  });

  it('validates input', async () => {
    const start = await firstSlot();
    await expectFailure(book(deps, { routeId: route.id, start, ...guest, email: 'not-an-email' }), 'invalid');
    await expectFailure(book(deps, { routeId: route.id, start, ...guest, name: '   ' }), 'invalid');
    await expectFailure(book(deps, { routeId: route.id, start, ...guest, note: 'x'.repeat(1501) }), 'invalid');
    await expectFailure(book(deps, { routeId: route.id, start, ...guest, timeZone: 'Mars/Olympus' }), 'invalid');
  });
});

describe('manage', () => {
  async function booked() {
    const start = await firstSlot();
    const result = await book(deps, { routeId: route.id, start, ...guest });
    return { start, token: result.manageUrl.split('/manage/')[1] };
  }

  it('rejects a forged or altered token', async () => {
    const { token } = await booked();
    const [id] = token.split('.');
    await expectFailure(lookup(deps, `${id}.AAAAAAAAAAAAAAAAAAAAAAAA`), 'not_found');
    await expectFailure(lookup(deps, token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')), 'not_found');
    await expectFailure(lookup({ ...deps, secret: SECRET + 'x' }, token), 'not_found');
  });

  it('reschedules into a time next to the original, which its own meeting would otherwise block', async () => {
    const { start, token } = await booked();
    const adjacent = new Date(new Date(start).getTime() + 30 * 60_000).toISOString();
    expect((await listSlots(deps, meeting.minutes)).map((s) => s.toISOString())).not.toContain(adjacent);

    const moved = await reschedule(deps, token, adjacent);
    expect(moved.start).toBe(adjacent);
    const { booking } = await lookup(deps, token);
    expect(booking.start.toISOString()).toBe(adjacent);
  });

  it('refuses to reschedule into a taken time', async () => {
    const { token } = await booked();
    const other = (await listSlots(deps, meeting.minutes))[3].toISOString();
    await book(deps, { routeId: route.id, start: other, ...guest, email: 'b@example.com' });
    await expectFailure(reschedule(deps, token, other), 'slot_taken');
  });

  it('cancels, frees the slot, and the link stops working', async () => {
    const { start, token } = await booked();
    await cancel(deps, token);
    await expectFailure(lookup(deps, token), 'not_found');
    expect((await listSlots(deps, meeting.minutes)).map((s) => s.toISOString())).toContain(start);
  });

  it('will not change a meeting that has started', async () => {
    const { start, token } = await booked();
    const later = { ...deps, now: () => new Date(new Date(start).getTime() + 60_000) };
    await expectFailure(cancel(later, token), 'already_happened');
    await expectFailure(reschedule(later, token, start), 'already_happened');
  });
});

describe('daily cap and event text', () => {
  it('closes a day once it holds the maximum number of bookings', async () => {
    const { availability } = await import('../src/config');
    const { dateKey } = await import('../src/lib/tz');
    const day = (d: Date) => dateKey(d, availability.timezone);

    const slots = await listSlots(deps, meeting.minutes);
    const firstDay = day(slots[0]);
    const sameDay = slots.filter((s) => day(s) === firstDay);
    // Book every other slot so buffers don't knock out the rest first.
    const picks = sameDay.filter((_, i) => i % 2 === 0).slice(0, availability.maxPerDay);
    expect(picks.length).toBe(availability.maxPerDay);
    for (const [i, s] of picks.entries()) {
      await book(deps, { routeId: route.id, start: s.toISOString(), ...guest, email: `cap${i}@example.com` });
    }
    expect((await listSlots(deps, meeting.minutes)).some((s) => day(s) === firstDay)).toBe(false);
  });

  it('gives Pavel the topic, the note, the manage link, and the guest’s timezone', async () => {
    const { describe: text } = await import('../src/lib/booking');
    const body = text(route, 'Ada', 'Engines.', 'https://meet.example/manage/x.y', 'Europe/London');
    expect(body).toBe(
      [
        `Topic: ${route.label}`,
        '',
        route.prompt,
        'Engines.',
        '',
        'Need to reschedule or cancel? https://meet.example/manage/x.y',
        '',
        'Booked by Ada at meet.example from Europe/London',
      ].join('\n')
    );
  });

  it('leaves out what the visitor didn’t give', async () => {
    const { describe: text } = await import('../src/lib/booking');
    expect(text(undefined, 'Ada', '', 'https://meet.example/manage/x.y')).toBe(
      'Need to reschedule or cancel? https://meet.example/manage/x.y\n\nBooked by Ada at meet.example'
    );
    expect(text(route, 'Ada', '', 'https://meet.example/manage/x.y')).toMatch(new RegExp(`^Topic: ${route.label}\n\nNeed to`));
    expect(text(undefined, 'Ada', 'Hi.', 'https://meet.example/manage/x.y')).toMatch(/^What’s on your mind\?\nHi\.\n/);
  });
});

describe('a topic with a length of its own', () => {
  const long: Route = { id: 'long-test', label: 'A long one', response: '', minutes: 60, prompt: 'Q?', placeholder: '' };
  beforeEach(() => void routes.push(long));
  afterEach(() => void routes.splice(routes.indexOf(long), 1));

  it('falls back to the meeting’s length when a topic has none', () => {
    expect(minutesFor(undefined)).toBe(meeting.minutes);
    expect(minutesFor(routes[0])).toBe(meeting.minutes);
    expect(minutesFor(long)).toBe(60);
  });

  it('books that length, refuses a time only the shorter length fits, and keeps the length when moved', async () => {
    const short = (await listSlots(deps, meeting.minutes)).map((s) => s.toISOString());
    const hour = (await listSlots(deps, 60)).map((s) => s.toISOString());
    const tooShort = short.find((s) => !hour.includes(s))!;
    expect(tooShort).toBeTruthy();
    await expectFailure(book(deps, { routeId: long.id, start: tooShort, ...guest }), 'slot_taken');

    const result = await book(deps, { routeId: long.id, start: hour[0], ...guest });
    expect(new Date(result.end).getTime() - new Date(hour[0]).getTime()).toBe(60 * 60_000);

    const token = result.manageUrl.split('/manage/')[1];
    const later = (await listSlots(deps, 60)).map((s) => s.toISOString()).find((s) => s > hour[0])!;
    const moved = await reschedule(deps, token, later);
    expect(new Date(moved.end).getTime() - new Date(moved.start).getTime()).toBe(60 * 60_000);
  });

  it('GET /api/slots answers for no topic, an unknown one, and one with its own length', async () => {
    const env = { CALENDAR_MODE: 'fake', SIGNING_SECRET: SECRET };
    const get = async (query: string) => {
      const url = new URL(`https://meet.example/api/slots${query}`);
      const res = await slotsApi({ locals: { runtime: { env } }, request: new Request(url), url } as unknown as Parameters<typeof slotsApi>[0]);
      return (await res.json()) as { ok: boolean; minutes: number; slots: string[] };
    };
    for (const query of ['', '?route=nope', '?route=ai-systems']) {
      expect(await get(query), query).toMatchObject({ ok: true, minutes: meeting.minutes });
    }
    const [hour, half] = [await get('?route=long-test'), await get('')];
    expect(hour.minutes).toBe(60);
    expect(hour.slots.length).toBeLessThan(half.slots.length);
  });
});
