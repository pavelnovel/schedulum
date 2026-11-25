import { describe, expect, it, vi } from 'vitest';
import { gmailMailer, mime, noteMessage, validateNote } from '../src/lib/note';
import { POST } from '../src/pages/api/note';

const ok = { name: 'Ada Lovelace', email: 'ada@example.com', text: 'Any Tuesday evening, my time.' };

describe('validateNote', () => {
  it('keeps what a note needs and drops what it can’t use', () => {
    expect(validateNote({ ...ok, routeId: 'speaking', timeZone: 'Asia/Tokyo' })).toEqual({ ...ok, routeId: 'speaking', timeZone: 'Asia/Tokyo' });
    expect(validateNote({ ...ok, routeId: 'nope', timeZone: 'Mars/Olympus' })).toEqual({ ...ok, routeId: undefined, timeZone: undefined });
  });

  it('explains what to fix', () => {
    expect(() => validateNote({ ...ok, name: ' ' })).toThrow('Enter your name.');
    expect(() => validateNote({ ...ok, email: 'nope' })).toThrow('Enter a valid email address.');
    expect(() => validateNote({ ...ok, text: '' })).toThrow('Write a line about what would work for you.');
    expect(() => validateNote({ ...ok, text: 'x'.repeat(2001) })).toThrow('Keep the note under 2,000 characters.');
  });

  it('refuses an address that could add a header, or that isn’t plain ASCII', () => {
    for (const email of ['ada@example.com>, eve@example.com', '"ada"@example.com', 'ada\u0085@example.com', 'ada\u0000@example.com', 'zoe@bücher.de']) {
      expect(() => validateNote({ ...ok, email }), email).toThrow('Enter a valid email address.');
    }
    expect(validateNote({ ...ok, email: "o'brien+cal@example.co.uk" }).email).toBe("o'brien+cal@example.co.uk");
  });

  it('encodes a subject that only looks encoded, and keeps long encoded words short', () => {
    const raw = mime({ ...noteMessage(validateNote({ ...ok, name: '=?UTF-8?B?SGk=?=' }), 'x'), to: 'pkonopl@gmail.com' }, 'pkonopl@gmail.com');
    expect(raw).not.toMatch(/^Subject: =\?UTF-8\?B\?SGk=\?=/m);
    const long = mime({ ...noteMessage(validateNote({ ...ok, name: 'Ж'.repeat(90) }), 'x'), to: 'pkonopl@gmail.com' }, 'pkonopl@gmail.com');
    for (const w of long.match(/=\?UTF-8\?B\?[^?]*\?=/g)!) expect(w.length).toBeLessThanOrEqual(75);
  });

  it('flattens a name that tries to start a new line', () => {
    expect(validateNote({ ...ok, name: 'Ada\r\nBcc: eve@example.com' }).name).toBe('Ada Bcc: eve@example.com');
  });
});

describe('noteMessage and mime', () => {
  const note = validateNote({ ...ok, routeId: 'speaking', timeZone: 'Asia/Tokyo' });
  const message = noteMessage(note, 'meet.pavelnovel.com', new Date('2026-10-26T12:00:00Z'));

  it('tells the host who wrote, about what, and when it is for them', () => {
    expect(message.to).toBe('pkonopl@gmail.com');
    expect(message.subject).toBe('Ada Lovelace would like to find a time');
    expect(message.body).toContain('Ada Lovelace (ada@example.com) sent a note from meet.pavelnovel.com instead of booking.');
    expect(message.body).toContain('Topic: A talk, podcast, panel, or workshop');
    expect(message.body).toContain('Their time zone: Asia/Tokyo, where it’s Mon, 9:00 PM Japan Standard Time now');
    expect(message.body).toContain('Any Tuesday evening, my time.');
  });

  it('keeps a name with quotes from adding a second reply address', () => {
    const raw = mime({ ...message, replyTo: { name: 'Eve" <evil@example.com>, "', email: 'eve@example.com' } }, 'pkonopl@gmail.com');
    const replyTo = raw.split('\r\n').find((line) => line.startsWith('Reply-To:'))!;
    expect(replyTo).toBe('Reply-To: "Eve <evil@example.com>, " <eve@example.com>');
    expect(mime({ ...message, replyTo: { name: 'Back\\slash', email: 'b@example.com' } }, 'x@example.com')).toContain('Reply-To: "Backslash" <b@example.com>');
  });

  it('builds an email whose replies go to the visitor', () => {
    const raw = mime({ ...message, replyTo: { name: 'Zoë', email: 'zoe@example.com' }, subject: 'Zoë would like to find a time' }, 'pkonopl@gmail.com');
    const [head, body] = raw.split('\r\n\r\n');
    expect(head).toContain('To: pkonopl@gmail.com');
    expect(head).toMatch(/^Reply-To: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <zoe@example\.com>$/m);
    expect(head).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    expect(head.split('\r\n').every((line) => /^[\x20-\x7e]+$/.test(line))).toBe(true);
    const text = new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\r\n/g, '')), (c) => c.charCodeAt(0)));
    expect(text).toBe(message.body);
  });
});

describe('gmailMailer', () => {
  const creds = { clientId: 'id', clientSecret: 'secret', refreshToken: `refresh-${Math.random()}` };
  const message = noteMessage(validateNote(ok), 'meet.example');

  it('sends the message as Gmail raw', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('oauth2')
        ? Response.json({ access_token: 'token', expires_in: 3600 })
        : Response.json({ id: 'm1' })
    );
    await gmailMailer(creds, fetcher as typeof fetch).send(message);
    const [url, init] = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    const raw = JSON.parse(String(init.body)).raw as string;
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))).toContain('Reply-To:');
  });

  it('reports a missing Gmail permission as an auth problem', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('oauth2')
        ? Response.json({ access_token: 'token', expires_in: 3600 })
        : new Response('{"error":{"status":"PERMISSION_DENIED"}}', { status: 403 })
    );
    await expect(gmailMailer({ ...creds, refreshToken: 'other' }, fetcher as typeof fetch).send(message)).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('POST /api/note', () => {
  const call = (body: Record<string, unknown>, env: Record<string, string> = { CALENDAR_MODE: 'fake' }) =>
    POST({
      request: new Request('https://meet.example/api/note', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      locals: { env },
    } as never);

  it('takes a note in development without sending anything', async () => {
    const res = await call(ok);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('turns away the honeypot and bad input', async () => {
    expect((await call({ ...ok, website: 'spam.example' })).status).toBe(400);
    expect((await call({ ...ok, email: 'nope' })).status).toBe(400);
  });

  it('needs the spam check when the secret is set', async () => {
    const res = await call(ok, { CALENDAR_MODE: 'fake', TURNSTILE_SECRET_KEY: 'secret' });
    expect(res.status).toBe(403);
  });

  it('turns notes off, not open, when the spam check is switched off', async () => {
    const res = await call(ok, { CALENDAR_MODE: 'google' });
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toBe('Notes are off for a moment. You can email pkonopl@gmail.com instead.');
  });

  it('offers email when the note can’t be sent, without logging the note', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', async () => Response.json({ success: true, action: 'note' }));
    // Spam check passes; Google isn't connected, so sending fails.
    const res = await call({ ...ok, turnstile: 'tok' }, { CALENDAR_MODE: 'google', TURNSTILE_SECRET_KEY: 'secret' });
    vi.unstubAllGlobals();
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toBe('Couldn’t send your note just now. You can email pkonopl@gmail.com instead.');
    expect(JSON.stringify(error.mock.calls)).not.toContain('Tuesday evening');
    expect(JSON.stringify(error.mock.calls)).not.toContain('ada@example.com');
    error.mockRestore();
  });

  it('won’t take a token from the booking form', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', async () => Response.json({ success: true, action: 'book' }));
    const res = await call({ ...ok, turnstile: 'tok' }, { CALENDAR_MODE: 'google', TURNSTILE_SECRET_KEY: 'secret' });
    vi.unstubAllGlobals();
    warn.mockRestore();
    expect(res.status).toBe(403);
  });
});
