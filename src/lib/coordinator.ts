import { availability, findRoute, minutesFor } from '../config';
import { book, BookingError, cancel, lengthOf, listSlots, lookup, reschedule, type Deps } from './booking';
import type { Env } from './env';
import { depsFrom, failure, json, readJson, str, visitorFrom } from './http';

async function changeBooking(deps: Deps, path: string, body: Record<string, unknown>): Promise<Response> {
  if (path === '/api/book') {
    const booking = await book(deps, {
      routeId: str(body.routeId),
      start: str(body.start),
      name: str(body.name),
      email: str(body.email),
      note: str(body.note),
      timeZone: str(body.timeZone) || undefined,
    });
    return json({ ok: true, booking });
  }

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
}

/** Every personal and work booking uses the same named Durable Object. */
export class BookingCoordinator {
  private pending: Promise<void> = Promise.resolve();

  constructor(_state: unknown, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '');
      const deps = depsFrom(this.env, request);
      if (request.method === 'POST' && (path === '/api/book' || path === '/api/manage')) {
        const body = await readJson(request);
        // Start the next availability check only after the preceding Google write
        // finishes. Convert failures to responses so the queue always advances.
        const result = this.pending.then(() => changeBooking(deps, path, body)).catch(failure);
        this.pending = result.then(() => undefined);
        return await result;
      }
      if (request.method === 'GET' && path === '/api/slots') {
        const token = url.searchParams.get('manage');
        const exclude = token ? (await lookup(deps, token)).booking : undefined;
        const minutes = exclude ? lengthOf(exclude) : minutesFor(findRoute(url.searchParams.get('route')));
        return json({
          ok: true,
          minutes,
          hostTimeZone: availability.timezone,
          slots: await listSlots(deps, minutes, exclude),
          visitor: visitorFrom('cf' in request ? request.cf : undefined),
        });
      }
      if (request.method === 'GET' && path.startsWith('/manage/')) {
        const { booking, label } = await lookup(deps, path.slice('/manage/'.length));
        return json({
          routeId: booking.routeId,
          label,
          minutes: lengthOf(booking),
          start: booking.start.toISOString(),
          end: booking.end.toISOString(),
          meetUrl: booking.meetUrl,
        });
      }
      return new Response(null, { status: 404 });
    } catch (err) {
      return failure(err);
    }
  }
}
