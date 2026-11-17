#!/usr/bin/env node
/**
 * One-time Google sign-in for Schedulum.
 *
 *   npm run connect-google
 *
 * Opens Google's consent screen for the Schedulum OAuth client, catches the
 * redirect on a loopback port, trades the code for a refresh token, checks
 * that the token can read free/busy, and writes everything to .dev.vars.
 *
 * The refresh token is never printed. It goes into .dev.vars (gitignored)
 * and, from there, into Cloudflare with the commands this script prints.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
  // Send only, to deliver visitors' notes to your own inbox. It can't read mail.
  'https://www.googleapis.com/auth/gmail.send',
];
const DEV_VARS = new URL('../.dev.vars', import.meta.url);
const PORT = Number(process.env.PORT ?? 53682);
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;

function readVars() {
  if (!existsSync(DEV_VARS)) return {};
  const vars = {};
  for (const line of readFileSync(DEV_VARS, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

function writeVars(updates) {
  let text = existsSync(DEV_VARS) ? readFileSync(DEV_VARS, 'utf8') : '';
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^#?\\s*${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
  }
  writeFileSync(DEV_VARS, text, { mode: 0o600 });
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function main() {
  const vars = readVars();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const clientId = process.env.GOOGLE_CLIENT_ID || vars.GOOGLE_CLIENT_ID || (await rl.question('OAuth client ID: ')).trim();
  const clientSecret =
    process.env.GOOGLE_CLIENT_SECRET || vars.GOOGLE_CLIENT_SECRET || (await rl.question('OAuth client secret: ')).trim();
  rl.close();
  if (!clientId || !clientSecret) throw new Error('A client ID and secret are required. See SETUP.md, step 1.');

  const verifier = b64url(randomBytes(48));
  const state = b64url(randomBytes(16));
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    // Forces a fresh refresh token even if this client was approved before.
    prompt: 'consent',
    login_hint: process.env.GOOGLE_ACCOUNT ?? 'pkonopl@gmail.com',
    state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  }).toString();

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT);
      if (url.pathname !== '/callback') return res.writeHead(404).end();
      const error = url.searchParams.get('error');
      const ok = !error && url.searchParams.get('state') === state && url.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        ok
          ? '<p style="font:16px system-ui;margin:3rem">Schedulum is connected. You can close this tab.</p>'
          : `<p style="font:16px system-ui;margin:3rem">Not connected: ${error ?? 'state mismatch'}. Check the terminal.</p>`
      );
      server.close();
      ok ? resolve(url.searchParams.get('code')) : reject(new Error(error ?? 'OAuth state mismatch'));
    });
    server.listen(PORT, '127.0.0.1', () => {
      console.log('\nOpen this link and sign in as the calendar owner:\n');
      console.log(auth.toString());
      console.log(`\nWaiting for Google on ${REDIRECT} …`);
    });
    server.on('error', reject);
  });

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokens.error} ${tokens.error_description ?? ''}`);
  if (!tokens.refresh_token) throw new Error('Google returned no refresh token. Remove Schedulum at myaccount.google.com/permissions and run this again.');

  const granted = new Set(String(tokens.scope ?? '').split(' '));
  const missing = SCOPES.filter((s) => !granted.has(s));
  if (missing.length) throw new Error(`These permissions were not granted: ${missing.join(', ')}. Run again and tick every box.`);

  // Prove the token works before saving it.
  const now = new Date();
  const fb = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      timeMin: now.toISOString(),
      timeMax: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
      items: [{ id: 'primary' }],
    }),
  });
  const fbJson = await fb.json();
  if (!fb.ok) throw new Error(`Free/busy check failed (${fb.status}): ${JSON.stringify(fbJson).slice(0, 300)}`);
  const blocks = fbJson.calendars?.primary?.busy?.length ?? 0;

  const updates = { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REFRESH_TOKEN: tokens.refresh_token };
  if (!vars.SIGNING_SECRET || vars.SIGNING_SECRET.startsWith('dev-only')) updates.SIGNING_SECRET = b64url(randomBytes(48));
  writeVars(updates);

  console.log(`\nConnected. Your primary calendar has ${blocks} busy block${blocks === 1 ? '' : 's'} in the next 7 days.`);
  console.log('Saved to .dev.vars. CALENDAR_MODE is unchanged; set it to google to test locally against the real calendar.');
  console.log('\nTo give the deployed site the same access, run:\n');
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'SIGNING_SECRET']) {
    console.log(`  grep '^${key}=' .dev.vars | cut -d= -f2- | npx wrangler secret put ${key}`);
  }
  console.log('');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
