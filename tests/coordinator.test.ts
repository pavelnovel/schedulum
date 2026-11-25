import { afterEach, expect, it, vi } from 'vitest';
import { meeting } from '../src/config';
import { book, listSlots, lookup } from '../src/lib/booking';
import * as runtime from '../src/lib/env';
import { fakeCalendar } from '../src/lib/fake';
import { depsFrom } from '../src/lib/http';
import { testLocals } from './coordinator-fixture';

afterEach(() => vi.restoreAllMocks());

it('serializes moves while the provider is still writing and preserves the losing appointment', async () => {
  const calendar = fakeCalendar('America/New_York');
  vi.spyOn(runtime, 'calendarFor').mockReturnValue(calendar);
  const { env } = testLocals({ SIGNING_SECRET: 'fixture'.repeat(6), CALENDAR_MODE: 'fake' });
  const url = 'https://calendar.example/api/manage';
  const deps = depsFrom(env, new Request(url));
  const appointments: { token: string; original: string }[] = [];
  for (const name of ['first', 'second']) {
    const [slot] = await listSlots(deps, meeting.minutes);
    const original = slot.toISOString();
    const { manageUrl } = await book(deps, { start: original, name, email: name + '@example.com' });
    appointments.push({ token: new URL(manageUrl).pathname.split('/').pop()!, original });
  }
  const [destination] = await listSlots(deps, meeting.minutes);
  const firstWrite = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const move = calendar.move.bind(calendar);
  const writes = vi.spyOn(calendar, 'move').mockImplementation(async (...args) => {
    firstWrite.resolve();
    await resume.promise;
    return move(...args);
  });

  const stub = env.BOOKING_COORDINATOR.getByName('host');
  const change = (token: string) => stub.fetch(new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'reschedule', token, start: destination.toISOString() }),
  }));
  const first = change(appointments[0].token);
  await firstWrite.promise;
  const second = change(appointments[1].token);
  // Once the second request has parsed its body, the first is still in Google.
  await new Promise(resolve => setTimeout(resolve, 25));
  resume.resolve();
  expect((await first).status).toBe(200);
  expect((await second).status).toBe(409);
  expect(writes).toHaveBeenCalledTimes(1);
  expect((await lookup(deps, appointments[1].token)).booking.start.toISOString()).toBe(appointments[1].original);
});
