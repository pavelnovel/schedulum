import type { APIRoute } from 'astro';
import { BookingError, cancel, reschedule } from '../../lib/booking';
import { depsFrom, failure, json, readJson, str } from '../../lib/http';

export const prerender = false;

/** POST { token, action: 'reschedule', start } | { token, action: 'cancel' } */
export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const body = await readJson(request);
    const deps = depsFrom(locals, request);
    const token = str(body.token);

    switch (body.action) {
      case 'reschedule':
        return json({ ok: true, booking: await reschedule(deps, token, str(body.start)) });
      case 'cancel':
        await cancel(deps, token);
        return json({ ok: true });
      default:
        throw new BookingError('invalid', 'Unknown action.');
    }
  } catch (err) {
    return failure(err);
  }
};
