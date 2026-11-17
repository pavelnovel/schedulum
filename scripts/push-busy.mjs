#!/usr/bin/env node
/**
 * Sends busy times from Google accounts Schedulum can't read itself, such as
 * a work account, to the live site. It runs on a server that already holds a
 * Google sign-in for each account. It only reads that sign-in's token file,
 * never changes it, and sends only start and end times.
 *
 *   node push-busy.mjs --setup <token file>…   # check the sign-ins; save them and a new shared secret
 *   node push-busy.mjs --secret                # print the secret, to pipe into `wrangler secret put`
 *   node push-busy.mjs --dry-run               # read and summarize; send nothing
 *   node push-busy.mjs                         # read and send once
 *   node push-busy.mjs --install               # send every 10 minutes, from a systemd user timer
 *   node push-busy.mjs --uninstall
 *
 * A token file is Google's authorized-user JSON (client_id, client_secret,
 * refresh_token, and optionally token_uri and account), as Google's own
 * libraries save it. Settings live in ~/.config/schedulum/push.json (mode
 * 600), and last-good.json beside it holds each account's last good busy
 * times. See SETUP.md.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = join(homedir(), '.config/schedulum');
const CONFIG = join(DIR, 'push.json');
const LAST_GOOD = join(DIR, 'last-good.json');
const INSTALLED = join(DIR, 'push-busy.mjs');
const UNITS = join(homedir(), '.config/systemd/user');
const UNIT = 'schedulum-busy';
const DEFAULT_URL = 'https://meet.pavelnovel.com';
const DAY_MS = 24 * 60 * 60 * 1000;
// Covers the 28-day booking horizon in src/config.ts, with room to spare.
const DAYS = 30;
const EVERY_MINUTES = 10;
// An account that can't be read keeps its last good busy times this long, then stops counting.
const GRACE_DAYS = 3;

/** Google's free/busy blocks as millisecond intervals, skipping any it can't read. */
export function busyFromFreeBusy(blocks = []) {
  return blocks.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })).filter((b) => b.start < b.end);
}

/** Sorts and joins overlapping or touching blocks. */
export function merge(blocks) {
  const out = [];
  for (const b of [...blocks].sort((x, y) => x.start - y.start)) {
    const last = out.at(-1);
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end);
    else out.push({ ...b });
  }
  return out;
}

/**
 * Joins this run's accounts. One that couldn't be read, because its sign-in
 * stopped working or Google refused, keeps its last good busy times for
 * GRACE_DAYS and then stops counting, so losing one account never stops the
 * others from syncing.
 */
export function withLastGood(results, saved, now) {
  const busy = [];
  const kept = {};
  const notes = [];
  for (const r of results) {
    if (r.busy) {
      busy.push(...r.busy);
      kept[r.name] = { at: now, busy: r.busy };
      continue;
    }
    const last = saved[r.name];
    if (last && now - last.at <= GRACE_DAYS * DAY_MS) {
      busy.push(...last.busy.filter((b) => b.end > now));
      kept[r.name] = last;
      notes.push(`${r.problem} Using its busy times from ${new Date(last.at).toISOString()}.`);
    } else {
      notes.push(`${r.problem} Leaving it out.`);
    }
  }
  return { busy: merge(busy), saved: kept, notes };
}

async function googleJson(url, init, what) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${what}: ${body.error_description ?? body.error?.message ?? body.error ?? res.status}`);
  return body;
}

/** One account's busy blocks on its primary calendar. The token file is only read. */
export async function readAccount(file, from, to) {
  const t = JSON.parse(readFileSync(file, 'utf8'));
  const { access_token } = await googleJson(
    t.token_uri ?? 'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      body: new URLSearchParams({ client_id: t.client_id, client_secret: t.client_secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' }),
    },
    'Google refused the sign-in'
  );
  const body = await googleJson(
    'https://www.googleapis.com/calendar/v3/freeBusy',
    {
      method: 'POST',
      headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: [{ id: 'primary' }] }),
    },
    'Google refused the free/busy lookup'
  );
  const calendar = body.calendars?.primary;
  if (!calendar || calendar.errors?.length) throw new Error(`Google couldn’t read the calendar: ${calendar?.errors?.[0]?.reason ?? 'no answer'}`);
  return { account: t.account, busy: busyFromFreeBusy(calendar.busy) };
}

/** Each account's busy blocks from now to DAYS days out, or why it couldn't be read. */
async function readAll(sources) {
  const from = Date.now();
  const to = from + DAYS * DAY_MS;
  const results = [];
  for (const { token, account } of sources) {
    try {
      results.push({ name: account, busy: (await readAccount(token, from, to)).busy });
    } catch (err) {
      results.push({ name: account, problem: `${account}: ${err.message}.` });
    }
  }
  return { until: to, results };
}

function readConfig() {
  if (!existsSync(CONFIG)) throw new Error('No settings yet. Run: node push-busy.mjs --setup <token file>');
  const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  if (!config.url || !config.secret || !config.sources?.length) throw new Error(`${CONFIG} needs url, secret, and sources.`);
  return config;
}

function readLastGood() {
  try {
    return JSON.parse(readFileSync(LAST_GOOD, 'utf8'));
  } catch {
    return {};
  }
}

async function setup(files) {
  if (!files.length) throw new Error('Name at least one token file.');
  const sources = [];
  const now = Date.now();
  // Stricter than a push: a sign-in that doesn't work now is a mistake.
  for (const file of files.map((f) => resolve(f))) {
    const { account, busy } = await readAccount(file, now, now + DAY_MS);
    // Some token files leave account empty; the path still tells accounts apart.
    sources.push({ token: file, account: account || file });
    console.log(`${account || file}: read its calendar, ${busy.length} busy blocks in the next day.`);
  }
  const existing = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {};
  // Keep the secret, so changing accounts never needs a new Worker secret.
  const secret = existing.secret ?? randomBytes(32).toString('hex');
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG, `${JSON.stringify({ url: existing.url ?? DEFAULT_URL, secret, sources }, null, 2)}\n`, { mode: 0o600 });
  console.log(`Saved ${CONFIG}.`);
  if (!existing.secret) {
    console.log(`Next, from the checkout, give the Worker the same secret:\n  ssh <this server> 'node ${fileURLToPath(import.meta.url)} --secret' | npx wrangler secret put BUSY_SYNC_SECRET`);
  }
}

async function push({ dryRun }) {
  const config = readConfig();
  const url = process.env.SCHEDULUM_URL ?? config.url;
  const { until, results } = await readAll(config.sources);
  const { busy, saved, notes } = withLastGood(results, readLastGood(), Date.now());
  const read = results.filter((r) => r.busy).length;
  const summary = [`${busy.length} busy blocks through ${new Date(until).toDateString()}, read from ${read} of ${results.length} accounts.`, ...notes].join(' ');
  if (dryRun) {
    console.log(`Would send to ${url}: ${summary}`);
    return;
  }
  const res = await fetch(new URL('/api/busy', url), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.secret}` },
    body: JSON.stringify({
      until: new Date(until).toISOString(),
      busy: busy.map((b) => ({ start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString() })),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const hint = { 401: ' The secret doesn’t match the Worker’s BUSY_SYNC_SECRET.', 404: ' Sync is off on the Worker: BUSY_SYNC_SECRET or the SYNCED_BUSY namespace is missing.' };
    throw new Error(`${url} refused the update (${res.status}).${hint[res.status] ?? ''}`);
  }
  // Saved only once the site has these times, so the file matches what the site counts.
  writeFileSync(LAST_GOOD, JSON.stringify(saved), { mode: 0o600 });
  console.log(`${new Date().toISOString()} sent ${summary}`);
}

const systemctl = (...args) => spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });

function install() {
  readConfig();
  const self = fileURLToPath(import.meta.url);
  if (resolve(self) !== INSTALLED) copyFileSync(self, INSTALLED);
  mkdirSync(UNITS, { recursive: true });
  writeFileSync(
    join(UNITS, `${UNIT}.service`),
    `[Unit]
Description=Send busy times to Schedulum

[Service]
Type=oneshot
ExecStart="${process.execPath}" "${INSTALLED}"
`
  );
  writeFileSync(
    join(UNITS, `${UNIT}.timer`),
    `[Unit]
Description=Send busy times to Schedulum every ${EVERY_MINUTES} minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=${EVERY_MINUTES}min

[Install]
WantedBy=timers.target
`
  );
  for (const args of [['daemon-reload'], ['enable', '--now', `${UNIT}.timer`]]) {
    const r = systemctl(...args);
    if (r.status !== 0) throw new Error(`systemctl --user ${args.join(' ')} failed: ${r.stderr.trim()}`);
  }
  console.log(`Installed. It sends every ${EVERY_MINUTES} minutes. Log: journalctl --user -u ${UNIT}`);
  console.log(`It runs ${process.execPath}; run --install again after updating the script or changing Node versions.`);
}

function uninstall() {
  systemctl('disable', '--now', `${UNIT}.timer`);
  rmSync(join(UNITS, `${UNIT}.timer`), { force: true });
  rmSync(join(UNITS, `${UNIT}.service`), { force: true });
  systemctl('daemon-reload');
  rmSync(INSTALLED, { force: true });
  console.log('Stopped. The site keeps counting the last push until you run: npx wrangler secret delete BUSY_SYNC_SECRET');
}

async function main(args) {
  const flag = args[0];
  if (flag === '--setup') return setup(args.slice(1));
  if (flag === '--secret') return void process.stdout.write(readConfig().secret);
  if (flag === '--install') return install();
  if (flag === '--uninstall') return uninstall();
  if (flag === '--dry-run' || flag === undefined) return push({ dryRun: flag === '--dry-run' });
  throw new Error(`Unknown option ${flag}. See the comment at the top of this script.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`${new Date().toISOString()} ${err.message}`);
    process.exit(1);
  });
}
