import type { APIRoute } from 'astro';
import { availability, findRoute, minutesFor } from '../../config';
import { lengthOf, listSlots, lookup } from '../../lib/booking';
import { depsFrom, failure, json, visitorFrom } from '../../lib/http';

export const prerender = false;

/**
 * GET /api/slots                       — open slots for a conversation
 * GET /api/slots?route=<id>            — the same, for a topic with its own length
 * GET /api/slots?manage=<token>        — open slots for moving an existing booking
 */
export const GET: APIRoute = async ({ locals, request, url }) => {
  try {
    const deps = depsFrom(locals, request);
    const token = url.searchParams.get('manage');

    let minutes = minutesFor(findRoute(url.searchParams.get('route')));
    let exclude;
    if (token) {
      exclude = (await lookup(deps, token)).booking;
      minutes = lengthOf(exclude);
    }

    const slots = await listSlots(deps, minutes, exclude);
    return json({
      ok: true,
      minutes,
      hostTimeZone: availability.timezone,
      slots: slots.map((s) => s.toISOString()),
      visitor: visitorFrom(locals.runtime?.cf),
    });
  } catch (err) {
    return failure(err);
  }
};
