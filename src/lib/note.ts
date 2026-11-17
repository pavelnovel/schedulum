/**
 * A note to the host, for a visitor none of the open times suit. It goes to
 * his Gmail inbox as an email from his own address, with the visitor as
 * Reply-To, so answering is one click. In development it goes nowhere.
 *
 * Schedulum keeps no copy of the note and never logs it.
 */
import { findRoute, host } from '../config';
import { BookingError } from './booking';
import { CalendarError } from './calendar';
import { googleAccessToken, type GoogleCredentials } from './google';
import { isValidTimeZone } from './tz';

const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export type Note = { name: string; email: string; text: string; routeId?: string; timeZone?: string };
export type Mailer = { send(message: Message): Promise<void> };
export type Message = { to: string; replyTo: { name: string; email: string }; subject: string; body: string };

// Header values must stay on one line; anything else could add headers.
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
// Stricter than booking's check: this address goes into a Reply-To header as
// it is, so printable ASCII only, and nothing that separates addresses.
const EMAIL = /^[!#-'*+\-./0-9=?A-Z^-~]+@[!#-'*+\-./0-9=?A-Z^-~]+\.[!#-'*+\-./0-9=?A-Z^-~]+$/;

export function validateNote(input: Record<string, string>): Note {
  const name = oneLine(input.name ?? '');
  const email = (input.email ?? '').trim();
  const text = (input.text ?? '').trim();
  if (name.length < 1 || name.length > 100) throw new BookingError('invalid', 'Enter your name.');
  if (email.length > 254 || !EMAIL.test(email)) throw new BookingError('invalid', 'Enter a valid email address.');
  if (text.length < 1) throw new BookingError('invalid', 'Write a line about what would work for you.');
  if (text.length > 2000) throw new BookingError('invalid', 'Keep the note under 2,000 characters.');
  const timeZone = input.timeZone && isValidTimeZone(input.timeZone) ? input.timeZone : undefined;
  const routeId = findRoute(input.routeId)?.id;
  return { name, email, text, routeId, timeZone };
}

/** The email the host gets. */
export function noteMessage(note: Note, site: string, now = new Date()): Message {
  const route = findRoute(note.routeId);
  const lines = [`${note.name} (${note.email}) sent a note from ${site} instead of booking.`, ''];
  if (route) lines.push(`Topic: ${route.label}`);
  if (note.timeZone) {
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: note.timeZone,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'longGeneric',
    }).format(now);
    lines.push(`Their time zone: ${note.timeZone}, where it’s ${local} now`);
  }
  if (route || note.timeZone) lines.push('');
  lines.push(note.text, '', 'Reply to this email to answer them.');
  return {
    to: host.email,
    replyTo: { name: note.name, email: note.email },
    subject: `${note.name} would like to find a time`,
    body: lines.join('\n'),
  };
}

const utf8 = new TextEncoder();
function base64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
/**
 * A header value as RFC 2047 encoded-words when it isn't plain ASCII, or when
 * it could be mistaken for one. Each word stays under the 75-character limit.
 */
function word(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s) && !s.includes('=?')) return s;
  const words: string[] = [];
  let chunk = '';
  for (const ch of s) {
    if (utf8.encode(chunk + ch).length > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${base64(utf8.encode(w))}?=`).join('\r\n ');
}
const address = (name: string, email: string) => `${word(`"${oneLine(name).replace(/["\\]/g, '')}"`)} <${email}>`;

/** RFC 5322 text, ready for Gmail's `raw`. */
export function mime(m: Message, from: string): string {
  const body = base64(utf8.encode(m.body)).replace(/.{76}/g, '$&\r\n');
  return [
    `From: ${address('Schedulum', from)}`,
    `To: ${m.to}`,
    `Reply-To: ${address(m.replyTo.name, m.replyTo.email)}`,
    `Subject: ${word(oneLine(m.subject))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

const base64url = (s: string) => base64(utf8.encode(s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function gmailMailer(creds: Pick<GoogleCredentials, 'clientId' | 'clientSecret' | 'refreshToken'>, fetcher: typeof fetch = fetch): Mailer {
  return {
    async send(m) {
      const res = await fetcher(SEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${await googleAccessToken(creds, fetcher)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ raw: base64url(mime(m, host.email)) }),
      });
      if (res.ok) return;
      // 403 here is the Gmail permission missing from an older sign-in, or the
      // Gmail API not enabled in the Cloud project; Google's answer says which.
      const kind = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
      throw new CalendarError(kind, `Gmail send: ${res.status} ${(await res.text()).slice(0, 200)}`);
    },
  };
}

/** Development: accepts every note and sends nothing. */
export function fakeMailer(): Mailer {
  return { async send() {} };
}
