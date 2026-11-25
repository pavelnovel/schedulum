import type { APIRoute } from 'astro';
import { BookingError } from '../../lib/booking';
import { coordinator, failure, readJson, requireEnabledRoute, str } from '../../lib/http';
import { verifyHuman } from '../../lib/turnstile';

export const prerender = false;

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const body = await readJson(request.clone());
    requireEnabledRoute(locals.env, body.routeId);
    // Honeypot: a field people never see. Bots fill it in.
    if (str(body.website)) throw new BookingError('invalid', 'Something went wrong. Try again.');

    const ip = request.headers.get('cf-connecting-ip');
    if (!(await verifyHuman(locals.env.TURNSTILE_SECRET_KEY, str(body.turnstile), ip, fetch, 'book'))) {
      throw new BookingError('unverified', 'The spam check didn’t go through. Try booking again.');
    }

    return await coordinator(locals.env).fetch(request);
  } catch (err) {
    return failure(err);
  }
};
