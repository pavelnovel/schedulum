import type { APIRoute } from 'astro';
import { book, BookingError } from '../../lib/booking';
import { depsFrom, envOf, failure, json, readJson, str } from '../../lib/http';
import { verifyHuman } from '../../lib/turnstile';

export const prerender = false;

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const body = await readJson(request);
    // Honeypot: a field people never see. Bots fill it in.
    if (str(body.website)) throw new BookingError('invalid', 'Something went wrong. Try again.');

    const ip = request.headers.get('cf-connecting-ip');
    if (!(await verifyHuman(envOf(locals).TURNSTILE_SECRET_KEY, str(body.turnstile), ip, fetch, 'book'))) {
      throw new BookingError('unverified', 'The spam check didn’t go through. Try booking again.');
    }

    const deps = depsFrom(locals, request);
    const booking = await book(deps, {
      routeId: str(body.routeId),
      start: str(body.start),
      name: str(body.name),
      email: str(body.email),
      note: str(body.note),
      timeZone: str(body.timeZone) || undefined,
    });
    return json({ ok: true, booking });
  } catch (err) {
    return failure(err);
  }
};
