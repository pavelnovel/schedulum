import type { APIRoute } from 'astro';
import { host } from '../../config';
import { BookingError } from '../../lib/booking';
import { calendarMode, mailerFor } from '../../lib/env';
import { failure, json, readJson, str } from '../../lib/http';
import { noteMessage, validateNote } from '../../lib/note';
import { verifyHuman } from '../../lib/turnstile';

export const prerender = false;

/** POST /api/note — a visitor none of the open times suit writes to the host instead. */
export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const body = await readJson(request);
    // Honeypot: a field people never see. Bots fill it in.
    if (str(body.website)) throw new BookingError('invalid', 'Something went wrong. Try again.');

    const env = locals.env;
    // Bookings are capped by the calendar; notes only by the spam check. With the
    // check switched off in an emergency, notes go off too rather than open a relay.
    if (!env.TURNSTILE_SECRET_KEY && calendarMode(env) !== 'fake') {
      return json({ ok: false, error: { code: 'unavailable', message: `Notes are off for a moment. You can email ${host.email} instead.` } }, 503);
    }
    const ip = request.headers.get('cf-connecting-ip');
    if (!(await verifyHuman(env.TURNSTILE_SECRET_KEY, str(body.turnstile), ip, fetch, 'note'))) {
      throw new BookingError('unverified', 'The spam check didn’t go through. Try sending again.');
    }

    const note = validateNote({
      name: str(body.name),
      email: str(body.email),
      text: str(body.text),
      routeId: str(body.routeId),
      timeZone: str(body.timeZone),
    });
    const site = new URL(env.PUBLIC_URL ?? request.url).host;
    try {
      await mailerFor(env).send(noteMessage(note, site));
    } catch (err) {
      // The detail is for the host's logs; the note itself never goes there.
      console.error('schedulum: note not sent:', err instanceof Error ? err.message : err);
      return json(
        { ok: false, error: { code: 'unavailable', message: `Couldn’t send your note just now. You can email ${host.email} instead.` } },
        503
      );
    }
    return json({ ok: true });
  } catch (err) {
    return failure(err);
  }
};
