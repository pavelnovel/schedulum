/**
 * Shared plumbing for the API routes: building the booking service from the
 * request's bindings, and turning failures into answers a visitor can act on.
 */
import { host } from '../config';
import { BookingError, type Deps } from './booking';
import { CalendarError } from './calendar';
import { calendarFor, notifier, signingSecret, type Env } from './env';
import { isValidTimeZone } from './tz';

export const envOf = (locals: App.Locals): Env => (locals.runtime?.env ?? {}) as Env;

export function depsFrom(locals: App.Locals, request: Request): Deps {
  const env = envOf(locals);
  return {
    calendar: calendarFor(env),
    secret: signingSecret(env),
    publicUrl: (env.PUBLIC_URL ?? new URL(request.url).origin).replace(/\/$/, ''),
    advertisingInviteEmail: env.ADVERTISING_INVITE_EMAIL,
    notify: notifier(env),
  };
}

export type Visitor = { timeZone?: string };

/**
 * Cloudflare's guess at the visitor's time zone, from their IP address. Only
 * the zone, never a place: the page uses it to notice a device clock that
 * disagrees, as on a VPN, or when the device gives no zone. It is echoed back
 * and never logged; it is saved only if the visitor books in it.
 */
export function visitorFrom(cf: unknown): Visitor {
  const zone = (cf as Record<string, unknown> | undefined)?.timezone;
  return typeof zone === 'string' && zone.length <= 64 && isValidTimeZone(zone) ? { timeZone: zone } : {};
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const STATUS: Record<BookingError['code'], number> = {
  invalid: 400,
  not_found: 404,
  slot_taken: 409,
  already_happened: 410,
  too_many: 429,
  unverified: 403,
};

export function failure(err: unknown): Response {
  if (err instanceof BookingError) {
    return json({ ok: false, error: { code: err.code, message: err.message } }, STATUS[err.code]);
  }
  // Calendar trouble is Pavel's problem to fix, not the visitor's. Log the
  // detail for him and give the visitor another way through.
  console.error('schedulum:', err instanceof CalendarError ? `${err.kind}: ${err.message}` : err);
  return json(
    {
      ok: false,
      error: {
        code: 'unavailable',
        message: `Booking is offline for a moment. You can email ${host.email} instead.`,
      },
    },
    503
  );
}

/** POST bodies must be JSON. A cross-site HTML form can't send that without a preflight. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    throw new BookingError('invalid', 'Expected JSON.');
  }
  try {
    const body = await request.json();
    if (body && typeof body === 'object') return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new BookingError('invalid', 'Expected JSON.');
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
