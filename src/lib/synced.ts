/**
 * Busy times from calendars Schedulum can't read itself, such as work
 * calendars on other Google accounts. A job on a server signed in to those
 * accounts pushes start and end times to PUT /api/busy
 * (scripts/push-busy.mjs). The latest push lives in KV and counts as busy
 * alongside Google's free/busy.
 */
import type { Interval } from './availability';
import { CalendarError, type Calendar } from './calendar';

/** The slice of a KV namespace this needs. */
export type Store = {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
};

export type Snapshot = { syncedAt: number; until: number; busy: Interval[] };

const KEY = 'pushed';
const HOUR = 60 * 60 * 1000;
// The job pushes every 10 minutes. Older than this, it has stopped; its
// blocks still count, but newer meetings are missing.
const STALE_MS = 6 * HOUR;
const MAX_BLOCKS = 2000;
const MAX_AHEAD_MS = 60 * 24 * HOUR;

/** The sync is on once both a long enough BUSY_SYNC_SECRET and the namespace exist. Deleting the secret turns it off. */
export function syncStore(env: { BUSY_SYNC_SECRET?: string; SYNCED_BUSY?: Store }): Store | null {
  const secret = env.BUSY_SYNC_SECRET;
  return secret && secret.length >= 32 && env.SYNCED_BUSY ? env.SYNCED_BUSY : null;
}

export function withSyncedBusy(calendar: Calendar, store: Store, now = Date.now): Calendar {
  return {
    ...calendar,
    async busy(from, to) {
      const [own, snapshot] = await Promise.all([calendar.busy(from, to), load(store)]);
      if (!snapshot) return own;
      if (now() - snapshot.syncedAt > STALE_MS) {
        console.warn(`schedulum: synced busy times are from ${new Date(snapshot.syncedAt).toISOString()}. Is the push job running?`);
      }
      const f = from.getTime();
      const t = to.getTime();
      const synced = snapshot.busy.filter((b) => b.end > f && b.start < t);
      // The last push says nothing past its end, so a job that stops pushing
      // closes the far end of the booking window rather than opening it up.
      if (snapshot.until < t) synced.push({ start: Math.max(snapshot.until, f), end: t });
      return [...own, ...synced];
    },
  };
}

async function load(store: Store): Promise<Snapshot | null> {
  try {
    return ((await store.get(KEY, 'json')) as Snapshot | null) ?? null;
  } catch (err) {
    // Same rule as an unreadable calendar: offering times that might be taken is worse than offering none.
    throw new CalendarError('upstream', `synced busy times: ${err instanceof Error ? err.message : err}`);
  }
}

export async function saveSnapshot(store: Store, snapshot: Snapshot): Promise<void> {
  await store.put(KEY, JSON.stringify(snapshot));
}

/** Checks a push: `{ until, busy: [{ start, end }] }` with ISO times. Null if it doesn't fit. */
export function parsePush(body: Record<string, unknown>, now: number): Snapshot | null {
  const until = typeof body.until === 'string' ? Date.parse(body.until) : NaN;
  if (!(until > now && until <= now + MAX_AHEAD_MS)) return null;
  if (!Array.isArray(body.busy) || body.busy.length > MAX_BLOCKS) return null;

  const busy: Interval[] = [];
  for (const b of body.busy) {
    const start = typeof b?.start === 'string' ? Date.parse(b.start) : NaN;
    const end = typeof b?.end === 'string' ? Date.parse(b.end) : NaN;
    if (!(start < end)) return null;
    busy.push({ start, end });
  }
  return { syncedAt: now, until, busy };
}
