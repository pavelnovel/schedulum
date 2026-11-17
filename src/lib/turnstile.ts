/**
 * Cloudflare Turnstile: evidence that a booking or a note came from a
 * person's browser, checked before Schedulum touches the calendar or Gmail.
 * Without a secret (local development) every request passes.
 */
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyHuman(
  secret: string | undefined,
  token: string,
  ip: string | null,
  fetcher: typeof fetch = fetch,
  /** The widget's action, so a token from the booking form can't send a note, or the other way round. */
  action?: string
): Promise<boolean> {
  if (!secret) return true;
  if (!token || token.length > 2048) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);
  try {
    const res = await fetcher(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(5000) });
    const json = (await res.json()) as { success?: boolean; action?: string; 'error-codes'?: string[] };
    if (json.success === true) {
      if (!action || !json.action || json.action === action) return true;
      console.warn(`schedulum: turnstile token was for "${json.action}", not "${action}"`);
      return false;
    }
    // Keys that don't pair show up here for every visitor, as invalid-input-secret
    // or invalid-input-response. One-off failures are usually expired tokens.
    console.warn('schedulum: turnstile refused a request:', json['error-codes']?.join(', ') || `HTTP ${res.status}`);
    return false;
  } catch (err) {
    // Can't confirm a person, so don't go ahead. The visitor can retry or email.
    console.warn('schedulum: turnstile unreachable:', err);
    return false;
  }
}
