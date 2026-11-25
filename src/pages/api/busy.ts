import type { APIRoute } from 'astro';
import { failure, json, readJson } from '../../lib/http';
import { parsePush, saveSnapshot, syncStore } from '../../lib/synced';
import { sameString } from '../../lib/tokens';

export const prerender = false;

/**
 * PUT /api/busy — replaces the busy times pushed by the job in
 * scripts/push-busy.mjs. Off unless BUSY_SYNC_SECRET and the SYNCED_BUSY
 * namespace are both set.
 */
export const PUT: APIRoute = async ({ locals, request }) => {
  const env = locals.env;
  const store = syncStore(env);
  if (!store) return json({ ok: false }, 404);
  if (!sameString(request.headers.get('authorization') ?? '', `Bearer ${env.BUSY_SYNC_SECRET}`)) return json({ ok: false }, 401);

  try {
    const snapshot = parsePush(await readJson(request), Date.now());
    if (!snapshot) return json({ ok: false, error: 'Expected { until, busy: [{ start, end }] } with ISO times.' }, 400);
    await saveSnapshot(store, snapshot);
    return json({ ok: true, blocks: snapshot.busy.length });
  } catch (err) {
    return failure(err);
  }
};
