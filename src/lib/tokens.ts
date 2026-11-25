/**
 * Manage links: `/manage/<eventId>.<signature>`.
 *
 * The event id is random and the signature is an HMAC over it, so a link
 * can't be guessed or forged, and it carries nothing about the guest.
 */

const encoder = new TextEncoder();
// Google event ids must be base32hex: lowercase a–v and digits.
const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';
const WORK_CALENDAR_PREFIX = 's';

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The prefix marks new work events. Older event IDs have exactly 26 characters. */
export function newEventId(workCalendar = false): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  let id = workCalendar ? WORK_CALENDAR_PREFIX : '';
  for (const b of bytes) id += BASE32HEX[b & 31];
  return id;
}

export function isWorkEventId(id: string): boolean {
  return id.length === 27 && id.startsWith(WORK_CALENDAR_PREFIX);
}

export async function signId(id: string, secret: string): Promise<string> {
  const sig = await hmac(secret, `manage:${id}`);
  return `${id}.${base64url(sig.slice(0, 18))}`;
}

export async function verifyToken(token: string, secret: string): Promise<string | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  if (!/^[0-9a-v]{5,1024}$/.test(id)) return null;

  return sameString(await signId(id, secret), token) ? id : null;
}

/** Constant-time compare, so a check doesn't leak how much of a forged value was right. */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A keyed hash of an email address. Lets Schedulum count a guest's bookings without querying by the address itself. */
export async function guestKey(email: string, secret: string): Promise<string> {
  return base64url((await hmac(secret, `guest:${mailbox(email)}`)).slice(0, 15)).replace(/[-_]/g, 'x');
}

/**
 * The inbox an address delivers to, so `ada+1@` and `ada+2@` count as one
 * guest. Gmail also ignores dots. A stranger who happens to share a
 * normalized address shares only the booking limit.
 */
export function mailbox(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  const original = lower.slice(0, at);
  let local = original.replace(/\+.*$/, '');
  let domain = lower.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  // An address that is all tag or dots stays as typed, so it can't share a limit with every other one.
  return `${local || original}@${domain}`;
}
