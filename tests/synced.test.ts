import { testLocals } from './coordinator-fixture';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { busyFromFreeBusy, merge, readAccount, withLastGood } from '../scripts/push-busy.mjs';
import { CalendarError, type Calendar } from '../src/lib/calendar';
import { parsePush, withSyncedBusy, type Store } from '../src/lib/synced';
import { PUT } from '../src/pages/api/busy';
import { GET } from '../src/pages/api/slots';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-19T14:00:00Z');

function memoryStore(): Store & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      const v = data.get(key);
      return v === undefined ? null : JSON.parse(v);
    },
    async put(key, value) {
      data.set(key, value);
    },
  };
}

const own = { start: NOW + HOUR, end: NOW + 2 * HOUR };
const google = { busy: async () => [own] } as unknown as Calendar;

afterEach(() => vi.restoreAllMocks());

describe('withSyncedBusy', () => {
  it('adds the synced blocks that fall in range to Google’s', async () => {
    const store = memoryStore();
    const inRange = { start: NOW + 3 * HOUR, end: NOW + 4 * HOUR };
    const later = { start: NOW + 50 * HOUR, end: NOW + 51 * HOUR };
    await store.put('pushed', JSON.stringify({ syncedAt: NOW, until: NOW + 99 * HOUR, busy: [inRange, later] }));
    const cal = withSyncedBusy(google, store, () => NOW);
    expect(await cal.busy(new Date(NOW), new Date(NOW + 24 * HOUR))).toEqual([own, inRange]);
  });

  it('is just Google’s free/busy before the first sync', async () => {
    const cal = withSyncedBusy(google, memoryStore(), () => NOW);
    expect(await cal.busy(new Date(NOW), new Date(NOW + 24 * HOUR))).toEqual([own]);
  });

  it('keeps using an old sync but logs that it’s old', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = memoryStore();
    const block = { start: NOW + 3 * HOUR, end: NOW + 4 * HOUR };
    await store.put('pushed', JSON.stringify({ syncedAt: NOW - 7 * HOUR, until: NOW + 99 * HOUR, busy: [block] }));
    const cal = withSyncedBusy(google, store, () => NOW);
    expect(await cal.busy(new Date(NOW), new Date(NOW + 24 * HOUR))).toContainEqual(block);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Is the push job running?'));
  });

  it('counts everything past the end of the last push as busy', async () => {
    const store = memoryStore();
    await store.put('pushed', JSON.stringify({ syncedAt: NOW, until: NOW + 10 * HOUR, busy: [] }));
    const cal = withSyncedBusy(google, store, () => NOW);
    expect(await cal.busy(new Date(NOW), new Date(NOW + 24 * HOUR))).toEqual([own, { start: NOW + 10 * HOUR, end: NOW + 24 * HOUR }]);
    expect(await cal.busy(new Date(NOW + 12 * HOUR), new Date(NOW + 24 * HOUR))).toContainEqual({ start: NOW + 12 * HOUR, end: NOW + 24 * HOUR });
  });

  it('fails closed when the store can’t be read', async () => {
    const broken: Store = { get: async () => Promise.reject(new Error('KV down')), put: async () => {} };
    const cal = withSyncedBusy(google, broken, () => NOW);
    await expect(cal.busy(new Date(NOW), new Date(NOW + HOUR))).rejects.toBeInstanceOf(CalendarError);
  });
});

describe('parsePush', () => {
  const iso = (t: number) => new Date(t).toISOString();
  const until = iso(NOW + 30 * 24 * HOUR);

  it('reads ISO blocks and stamps the time it arrived', () => {
    expect(parsePush({ until, busy: [{ start: iso(NOW), end: iso(NOW + HOUR) }] }, NOW)).toEqual({
      syncedAt: NOW,
      until: NOW + 30 * 24 * HOUR,
      busy: [{ start: NOW, end: NOW + HOUR }],
    });
  });

  it.each([
    ['an end in the past', { until: iso(NOW - HOUR), busy: [] }],
    ['an end too far out', { until: iso(NOW + 61 * 24 * HOUR), busy: [] }],
    ['no list', { until, busy: 'all day' }],
    ['too many blocks', { until, busy: Array.from({ length: 2001 }, () => ({ start: iso(NOW), end: iso(NOW + HOUR) })) }],
    ['a block that ends before it starts', { until, busy: [{ start: iso(NOW + HOUR), end: iso(NOW) }] }],
    ['a block that isn’t a time', { until, busy: [{ start: 'noon', end: iso(NOW) }] }],
    ['a block that isn’t an object', { until, busy: [null] }],
  ])('refuses %s', (_, body) => {
    expect(parsePush(body as Record<string, unknown>, NOW)).toBeNull();
  });
});

describe('PUT /api/busy', () => {
  const SECRET = 'sync-secret-that-is-at-least-32-characters';
  const base = { CALENDAR_MODE: 'fake', SIGNING_SECRET: 'test-secret-that-is-at-least-32-characters-long' };

  const put = (env: Record<string, unknown>, body: unknown, auth = `Bearer ${SECRET}`) =>
    PUT({
      locals: testLocals(env),
      request: new Request('https://meet.example/api/busy', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify(body),
      }),
    } as unknown as Parameters<typeof PUT>[0]);

  const slots = async (env: Record<string, unknown>) => {
    const res = await GET({
      locals: testLocals(env),
      request: new Request('https://meet.example/api/slots?route=ai-systems'),
      url: new URL('https://meet.example/api/slots?route=ai-systems'),
    } as unknown as Parameters<typeof GET>[0]);
    return ((await res.json()) as { slots: string[] }).slots;
  };

  const until = () => new Date(Date.now() + 30 * 24 * HOUR).toISOString();

  it('is off without a secret or a store', async () => {
    expect((await put({ ...base, SYNCED_BUSY: memoryStore() }, {})).status).toBe(404);
    expect((await put({ ...base, SYNCED_BUSY: memoryStore(), BUSY_SYNC_SECRET: 'short' }, {})).status).toBe(404);
    expect((await put({ ...base, BUSY_SYNC_SECRET: SECRET }, {})).status).toBe(404);
  });

  it('refuses the wrong secret and stores nothing', async () => {
    const store = memoryStore();
    const res = await put({ ...base, SYNCED_BUSY: store, BUSY_SYNC_SECRET: SECRET }, { until: until(), busy: [] }, 'Bearer nope');
    expect(res.status).toBe(401);
    expect(store.data.size).toBe(0);
  });

  it('refuses a malformed update', async () => {
    const res = await put({ ...base, SYNCED_BUSY: memoryStore(), BUSY_SYNC_SECRET: SECRET }, { busy: [] });
    expect(res.status).toBe(400);
  });

  it('stops offering a time once a synced block covers it', async () => {
    const env = { ...base, SYNCED_BUSY: memoryStore(), BUSY_SYNC_SECRET: SECRET };
    const before = await slots(env);
    expect(before.length).toBeGreaterThan(0);
    const taken = Date.parse(before[0]);

    const res = await put(env, { until: until(), busy: [{ start: before[0], end: new Date(taken + HOUR / 2).toISOString() }] });
    expect(await res.json()).toEqual({ ok: true, blocks: 1 });

    const after = await slots(env);
    expect(after).not.toContain(before[0]);
    expect(after.length).toBeGreaterThan(0);

    // Deleting the secret turns the sync off, stored blocks included.
    expect(await slots({ ...env, BUSY_SYNC_SECRET: undefined })).toContain(before[0]);
  });
});

describe('push job (scripts/push-busy.mjs)', () => {
  const DAY = 24 * HOUR;
  const iso = (h: number) => new Date(NOW + h * HOUR).toISOString();
  const block = (a: number, b: number) => ({ start: NOW + a * HOUR, end: NOW + b * HOUR });
  const gone = { name: 'pk@old.example', problem: 'pk@old.example: Google refused the sign-in: invalid_grant.' };

  function tokenFile() {
    const file = join(mkdtempSync(join(tmpdir(), 'push-busy-')), 'token.json');
    const text = JSON.stringify({ account: 'pk@work.example', client_id: 'id', client_secret: 'cs', refresh_token: 'rt', token_uri: 'https://oauth2.example/token' });
    writeFileSync(file, text);
    return { file, text };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('reads an account’s primary calendar and leaves its token file alone', async () => {
    const { file, text } = tokenFile();
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      if (url === 'https://oauth2.example/token') return Response.json({ access_token: 'at' });
      return Response.json({ calendars: { primary: { busy: [{ start: iso(1), end: iso(2) }] } } });
    });

    expect(await readAccount(file, NOW, NOW + 4 * HOUR)).toEqual({ account: 'pk@work.example', busy: [block(1, 2)] });
    expect(String(calls[0][1].body)).toContain('grant_type=refresh_token');
    expect(calls[1][1].headers).toMatchObject({ authorization: 'Bearer at' });
    expect(JSON.parse(String(calls[1][1].body))).toMatchObject({ timeMin: iso(0), timeMax: iso(4), items: [{ id: 'primary' }] });
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('fails when Google can’t read the calendar or refuses the sign-in', async () => {
    const { file } = tokenFile();
    vi.stubGlobal('fetch', async (url: string) =>
      url.includes('oauth2') ? Response.json({ access_token: 'at' }) : Response.json({ calendars: { primary: { errors: [{ reason: 'notFound' }] } } })
    );
    await expect(readAccount(file, NOW, NOW + HOUR)).rejects.toThrow('notFound');

    vi.stubGlobal('fetch', async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    await expect(readAccount(file, NOW, NOW + HOUR)).rejects.toThrow('invalid_grant');
  });

  it('skips free/busy blocks it can’t read', () => {
    expect(busyFromFreeBusy([{ start: iso(1), end: iso(2) }, { start: 'soon', end: iso(3) }, { start: iso(5), end: iso(4) }])).toEqual([block(1, 2)]);
    expect(busyFromFreeBusy(undefined)).toEqual([]);
  });

  it('keeps sending the other accounts when one can’t be read', () => {
    const { busy, saved, notes } = withLastGood([{ name: 'pk@work.example', busy: [block(1, 2)] }, gone], {}, NOW);
    expect(busy).toEqual([block(1, 2)]);
    expect(saved).toEqual({ 'pk@work.example': { at: NOW, busy: [block(1, 2)] } });
    expect(notes).toEqual(['pk@old.example: Google refused the sign-in: invalid_grant. Leaving it out.']);
  });

  it('uses an unreadable account’s last good times for three days, then drops it', () => {
    const last = { 'pk@old.example': { at: NOW - 2 * DAY, busy: [block(-1, -0.5), block(5, 6)] } };
    const within = withLastGood([gone], last, NOW);
    expect(within.busy).toEqual([block(5, 6)]);
    expect(within.saved).toEqual(last);

    const after = withLastGood([gone], last, NOW + 1.5 * DAY);
    expect(after.busy).toEqual([]);
    expect(after.saved).toEqual({});
  });

  it('merges blocks from several accounts', () => {
    expect(merge([block(3, 5), block(0, 1), block(4, 6), block(1, 2)])).toEqual([block(0, 2), block(3, 6)]);
  });
});
