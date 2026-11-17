import { describe, expect, it, vi } from 'vitest';
import { POST } from '../src/pages/api/book';
import { verifyHuman } from '../src/lib/turnstile';

function siteverify(result: unknown) {
  const calls: URLSearchParams[] = [];
  const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init?.body as URLSearchParams);
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result));
  }) as typeof fetch;
  return { fetcher, calls };
}

describe('verifyHuman', () => {
  it('passes everything when no secret is set', async () => {
    const { fetcher, calls } = siteverify({ success: false });
    expect(await verifyHuman(undefined, '', null, fetcher)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('asks Cloudflare about the token, with the visitor’s IP', async () => {
    const { fetcher, calls } = siteverify({ success: true });
    expect(await verifyHuman('secret', 'tok', '203.0.113.7', fetcher)).toBe(true);
    expect(Object.fromEntries(calls[0])).toEqual({ secret: 'secret', response: 'tok', remoteip: '203.0.113.7' });
  });

  it('refuses a missing token without asking', async () => {
    const { fetcher, calls } = siteverify({ success: true });
    expect(await verifyHuman('secret', '', null, fetcher)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('refuses a token Cloudflare rejects, and logs why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetcher } = siteverify({ success: false, 'error-codes': ['invalid-input-secret'] });
    expect(await verifyHuman('secret', 'tok', null, fetcher)).toBe(false);
    expect(warn.mock.calls[0].join(' ')).toContain('invalid-input-secret');
    warn.mockRestore();
  });

  it('refuses a token minted for the other form', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetcher } = siteverify({ success: true, action: 'book' });
    expect(await verifyHuman('secret', 'tok', null, fetcher, 'note')).toBe(false);
    expect(await verifyHuman('secret', 'tok', null, fetcher, 'book')).toBe(true);
    warn.mockRestore();
  });

  it('refuses when Cloudflare can’t be reached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetcher } = siteverify(new Error('network'));
    expect(await verifyHuman('secret', 'tok', null, fetcher)).toBe(false);
    warn.mockRestore();
  });
});

describe('POST /api/book', () => {
  const env = { CALENDAR_MODE: 'fake', SIGNING_SECRET: 'test-secret-that-is-at-least-32-characters-long' };
  const post = (extra: Record<string, string>) =>
    POST({
      locals: { runtime: { env: { ...env, ...extra } } },
      request: new Request('https://meet.example/api/book', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ routeId: 'nope', start: '2026-10-21T14:00:00Z', name: 'Ada', email: 'ada@example.com' }),
      }),
    } as unknown as Parameters<typeof POST>[0]);

  it('refuses a booking without a spam-check token when the secret is set', async () => {
    const res = await post({ TURNSTILE_SECRET_KEY: 'secret' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'unverified' } });
  });

  it('skips the spam check without a secret', async () => {
    // Past the check, the booking rules answer: that time is gone.
    const res = await post({});
    expect(await res.json()).toMatchObject({ error: { code: 'slot_taken' } });
  });
});
