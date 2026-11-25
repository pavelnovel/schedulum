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
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';

const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
];
const advertising = process.argv.includes('--advertising');
const requiredScopes = advertising ? CALENDAR_SCOPES : [...CALENDAR_SCOPES, 'https://www.googleapis.com/auth/gmail.send'];
const requestedScopes = advertising ? [...requiredScopes, 'openid', 'email'] : requiredScopes;
const prefix = advertising ? 'ADVERTISING_GOOGLE_' : 'GOOGLE_';
const DEV_VARS = new URL('../.dev.vars', import.meta.url);
const PORT = Number(process.env.PORT ?? 53682);
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;

function readVars() {
  return existsSync(DEV_VARS) ? parseEnv(readFileSync(DEV_VARS, 'utf8')) : {};
}

export function writeVars(updates, file = fileURLToPath(DEV_VARS)) {
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const saved = parseEnv(text);
  // A first connection is a local demo until the operator explicitly selects Google.
  if (!['fake', 'google'].includes(saved.CALENDAR_MODE)) updates = { ...updates, CALENDAR_MODE: 'fake' };
  if (!saved.PUBLIC_URL) updates = { ...updates, PUBLIC_URL: 'http://localhost:4321' };
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, 'gm');
    text = re.test(text) ? text.replace(re, () => line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
  }
  // Replace the inode: an existing example may have been created with mode 0644.
  const temp = file + '.' + randomBytes(12).toString('hex') + '.tmp';
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function main() {
  const vars = readVars();
  const expectedAccount = process.env.GOOGLE_ACCOUNT?.trim().toLowerCase();
  if (advertising && !expectedAccount) throw new Error('Set GOOGLE_ACCOUNT to the work Google account before connecting it.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const clientId = process.env.GOOGLE_CLIENT_ID || vars[`${prefix}CLIENT_ID`] || vars.GOOGLE_CLIENT_ID || (await rl.question('OAuth client ID: ')).trim();
  const clientSecret =
    process.env.GOOGLE_CLIENT_SECRET || vars[`${prefix}CLIENT_SECRET`] || vars.GOOGLE_CLIENT_SECRET || (await rl.question('OAuth client secret: ')).trim();
  rl.close();
  if (!clientId || !clientSecret) throw new Error('A client ID and secret are required. See SETUP.md, step 1.');

  const verifier = b64url(randomBytes(48));
  const state = b64url(randomBytes(16));
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: requestedScopes.join(' '),
    access_type: 'offline',
    // Forces a fresh refresh token even if this client was approved before.
    prompt: 'consent',
    ...(expectedAccount && { login_hint: expectedAccount }),
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
          ? '<p style="font:16px system-ui;margin:3rem">Schedulum received Google’s response. You can close this tab.</p>'
          : '<p style="font:16px system-ui;margin:3rem">Google sign-in did not finish. Check the terminal.</p>'
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
  const missing = requiredScopes.filter((s) => !granted.has(s));
  if (missing.length) throw new Error(`These permissions were not granted: ${missing.join(', ')}. Run again and tick every box.`);
  if (advertising) {
    const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const account = await res.json();
    if (!res.ok || account.email_verified !== true || account.email?.toLowerCase() !== expectedAccount) {
      throw new Error('Google did not verify the expected work account. Run again and choose the work account.');
    }
  }

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
  if (!fb.ok || !Array.isArray(fbJson.calendars?.primary?.busy)) throw new Error(`Free/busy check failed (${fb.status}).`);
  const blocks = fbJson.calendars?.primary?.busy?.length ?? 0;

  const updates = { [`${prefix}CLIENT_ID`]: clientId, [`${prefix}CLIENT_SECRET`]: clientSecret, [`${prefix}REFRESH_TOKEN`]: tokens.refresh_token };
  if (!advertising && (!vars.SIGNING_SECRET || vars.SIGNING_SECRET.startsWith('dev-only'))) updates.SIGNING_SECRET = b64url(randomBytes(48));
  writeVars(updates);

  console.log(`\nConnected. Your primary calendar has ${blocks} busy block${blocks === 1 ? '' : 's'} in the next 7 days.`);
  console.log(`Saved to .dev.vars. Local calendar mode: ${readVars().CALENDAR_MODE}.`);
  console.log('\nTo give the deployed site the same access, run:\n');
  const keys = ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN'].map((key) => prefix + key);
  if (!advertising) keys.push('SIGNING_SECRET');
  for (const key of keys) {
    console.log(`  grep '^${key}=' .dev.vars | cut -d= -f2- | npx wrangler secret put ${key}`);
  }
  console.log('');
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  });
}
