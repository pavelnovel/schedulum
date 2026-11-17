# Setting up Schedulum

Schedulum is live at `meet.pavelnovel.com` (set up 2026-10-19). Come back to
this page to rebuild the setup from scratch, reconnect the calendar, or
redeploy.

What exists now:

| Piece | Where |
| --- | --- |
| Google Cloud project | `schedulum-512104` on `pkonopl@gmail.com` |
| OAuth client | Desktop app named `Schedulum`, consent screen **In production** |
| Cloudflare Worker | `schedulum` in Pkonopl@gmail.com's Account |
| Domain | `meet.pavelnovel.com`, a Worker custom domain set in `wrangler.toml` |
| Spam check | Turnstile widget `Schedulum`, Managed mode, for `meet.pavelnovel.com` |
| Deploys | Workers Builds: every push to `main` builds and deploys the Worker |

## 1. Create the Google OAuth client

Schedulum gets its own OAuth client. It doesn't reuse your personal
assistant's, whose published policy forbids sending invitations without your
approval each time.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project named **Schedulum**.
2. Enable the **Google Calendar API** and the **Gmail API**: APIs & Services
   → Library → each one → Enable. Gmail is only for sending visitors' notes
   to you.
3. In Google Auth Platform, choose **Get started**:
   - App name: **Schedulum**
   - User support and developer contact email: `pkonopl@gmail.com`
   - Audience: **External**
   - Agree to the Google API Services User Data Policy.
4. Under **Data Access**, add these three scopes and save:
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/calendar.freebusy`
   - `https://www.googleapis.com/auth/gmail.send`
5. Under **Branding**, fill in the fields Google requires before you can
   publish, then save:
   - Application home page: `https://meet.pavelnovel.com`
   - Application privacy policy link: `https://meet.pavelnovel.com/privacy`
   - Authorized domain: `pavelnovel.com`
6. Under **Audience**, select **Publish app**, then **Confirm**, to move it to
   **In production**. Google then says the app "requires verification". Ignore
   that: verification is for apps other people sign in to.

   > **Don't skip this.** In Testing, Google expires refresh tokens after seven
   > days, and booking then stops without warning. An unverified production app
   > used only by you is allowed.

7. Under **Clients**, create an OAuth client with application type **Desktop
   app**, named `Schedulum`. Google shows the client secret only once, in the
   dialog that follows, so copy the client ID and secret before closing it.

## 2. Connect your calendar

Put the client ID and secret in `.dev.vars` as `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET`, or paste them when asked. Then run:

```bash
npm install
npm run connect-google
```

Open the printed link and sign in as `pkonopl@gmail.com`. At "Google hasn't
verified this app", check that the developer email shown is yours, then
choose **Advanced** → **Go to Schedulum (unsafe)**. Tick all three permissions.
Google describes the first one as "View and edit events on all your calendars".
Schedulum only reads free/busy and changes the events it booked, but no
narrower permission lets it send invites from your main calendar. The Gmail
one, "Send email on your behalf", delivers a visitor's note to your own inbox,
with the visitor as Reply-To. It can't read your mail.

The script checks that it can read your free/busy before it saves anything.
It writes the credentials and a fresh `SIGNING_SECRET` to `.dev.vars`, which
git ignores. It never prints the refresh token.

To make other calendars block booking, such as a shared family calendar, put
their IDs in `BUSY_CALENDARS` in `wrangler.toml`, separated by commas:

```toml
BUSY_CALENDARS = "primary,family123@group.calendar.google.com"
```

Calendars on other accounts, such as work calendars, can be pushed from a
server that's signed in to them. See
[Work calendars from another server](#work-calendars-from-another-server).

## 3. Try it locally

```bash
npm run dev       # http://localhost:4321, Astro's dev server
npm run preview   # http://localhost:8787, the real Workers runtime
```

`.dev.vars` starts with `CALENDAR_MODE=fake`: an in-memory calendar with
made-up busy blocks, safe to click through. Change it to `google` to see your
real availability. Production has no `CALENDAR_MODE`, which means `google`.

Locally the spam check is off: `npm run dev` has no Turnstile key, and
`npm run preview` uses Cloudflare's always-pass test key. Neither has the
secret, so the server lets every booking through. To try it with the check
on, give the local Worker Cloudflare's always-pass test secret:

```bash
npm run preview -- --var TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA
```

> In `google` mode a booking creates a real event and emails a real invite.
> Use your own address as the guest. Manage links point at `PUBLIC_URL`, which
> is `localhost` in `.dev.vars`, so cancel test bookings from the local site.

## 4. Deploy to Cloudflare

```bash
npx wrangler login
npm run deploy
```

`npm run deploy` builds the site and runs `wrangler deploy`. The first deploy
creates the `schedulum` Worker and attaches `meet.pavelnovel.com`. The
`pavelnovel.com` zone is in the same Cloudflare account, so Cloudflare creates
the DNS record and certificate itself. `PUBLIC_URL`, `BUSY_CALENDARS`, and the
domain all live in `wrangler.toml`.

Copy the secrets from `.dev.vars` into the Worker. This sends all four in one
go and prints none of them:

```bash
node -e "const fs=require('fs');const v={};for(const l of fs.readFileSync('.dev.vars','utf8').split('\n')){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m)v[m[1]]=m[2]}process.stdout.write(JSON.stringify(Object.fromEntries(['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN','SIGNING_SECRET'].map(k=>[k,v[k]]))))" | npx wrangler secret bulk
```

After a reconnect, only `GOOGLE_REFRESH_TOKEN` changes:

```bash
grep '^GOOGLE_REFRESH_TOKEN=' .dev.vars | cut -d= -f2- | npx wrangler secret put GOOGLE_REFRESH_TOKEN
```

`public/.assetsignore` keeps the server bundle (`_worker.js`) out of the public
files. Don't remove it.

### Deploy on every push

In the Cloudflare dashboard, open Workers & Pages → **schedulum** → Settings
→ Build, and connect the GitHub repository. Use branch `main`, build command
`npm run build`, and deploy command `npx wrangler deploy`. Turn off builds for
other branches: they would run with the real calendar's secrets. From then on,
every push to `main` deploys, and `npm run deploy` is only needed from a
machine without the repository connected.

### The spam check (Turnstile)

New bookings must pass Cloudflare Turnstile. Most visitors never see it; it
asks for a click only when it isn't sure. To set it up from scratch:

1. In the Cloudflare dashboard, open Application security → Turnstile →
   **Add widget**. Name it `Schedulum`, add the hostname
   `meet.pavelnovel.com`, keep **Managed** mode, and create it.
2. Put the site key in `.env.production` as `PUBLIC_TURNSTILE_SITE_KEY`. It's
   public and committed, and the build puts it into the page.
3. Store the secret key in the Worker:

   ```bash
   npx wrangler secret put TURNSTILE_SECRET_KEY
   ```

The two keys only work as a pair. If the secret is set but the page has no
site key, or a key from another widget, every booking fails with "The spam
check didn't go through".

### Optional: a ping when someone books

Set `NOTIFY_WEBHOOK_URL` to any endpoint that accepts `{"text": "..."}`, such
as a Slack incoming webhook or a Telegram relay. You get a one-line message
for every booking, reschedule, and cancellation. Google doesn't notify you
about events Schedulum creates on your behalf, so this is the only alert you
get.

```bash
npx wrangler secret put NOTIFY_WEBHOOK_URL
```

### Work calendars from another server

Schedulum's Google connection reads only calendars that `pkonopl@gmail.com`
can see. For calendars on other Google accounts, a job on a server that's
already signed in to them sends their busy times, with no titles, to the site
every 10 minutes.
Pavel's runs on an always-on server.

The job needs Node 18 or later. Each account is a token file in Google's
authorized-user format (`client_id`, `client_secret`, `refresh_token`), as
Google's own libraries save it. The job only reads the file.

1. Copy the script to the server and check the sign-ins. This saves them,
   with a new shared secret, in `~/.config/schedulum/push.json` there:

   ```bash
   ssh <server> 'mkdir -p ~/.config/schedulum'
   scp scripts/push-busy.mjs <server>:.config/schedulum/
   ssh <server> 'node ~/.config/schedulum/push-busy.mjs --setup /path/to/token.json'
   ```

2. Give the Worker the same secret. It passes straight through and is never
   printed:

   ```bash
   ssh <server> 'node ~/.config/schedulum/push-busy.mjs --secret' | npx wrangler secret put BUSY_SYNC_SECRET
   ```

3. Check what would be sent, send once, then keep it running:

   ```bash
   ssh <server> 'node ~/.config/schedulum/push-busy.mjs --dry-run'
   ssh <server> 'node ~/.config/schedulum/push-busy.mjs'
   ssh <server> 'node ~/.config/schedulum/push-busy.mjs --install'
   ```

`--install` adds a systemd user timer, `schedulum-busy`. See its log with
`journalctl --user -u schedulum-busy`. It runs while you're logged out only
if lingering is on for that user (`loginctl enable-linger`).

- **To change accounts**, run `--setup` again with the new token files. The
  secret stays the same.
- **After updating the script or changing Node versions**, copy it again and
  run `--install` again.
- **To stop**, run `--uninstall` on the server, then
  `npx wrangler secret delete BUSY_SYNC_SECRET`. Without the secret the site
  ignores the busy times it stored. Uninstalling alone leaves the site
  counting the last push, and blocking every day past the 30 it covered.

The site only knows what the last push said, so a meeting added in the last
10 minutes can still be booked over. Days past the 30 that the last push
covered count as busy, so a job that stops shortens the booking window
rather than opening it up.

If an account can't be read, for example because its sign-in was revoked,
the job keeps sending the others. That account keeps its last good busy
times for three days, then stops counting, and each run's log line names it.

## 5. Check it end to end

1. Open `https://meet.pavelnovel.com` and book a slot with your own address
   as the guest. A `+` alias such as `pkonopl+test@gmail.com` lands in your
   inbox.
2. Confirm the event is on your calendar with a Meet link, and the invite
   arrived.
3. Open **Reschedule or cancel** from the invite, move the meeting, then cancel
   it. Both changes should reach your calendar and inbox.
4. Add a test event to your calendar and reload. Those times should disappear.

## Changing things later

| To change | Edit |
| --- | --- |
| Working hours, buffers, notice, horizon, daily cap | `availability` in `src/config.ts` |
| The visitor's hours offered by default (9 AM to 7 PM their time) | `visitorHours` in `src/config.ts` |
| Meeting length, and the question asked when no topic is picked | `meeting` in `src/config.ts` |
| Topics and their copy and question; a topic's own length, if it differs | `routes` in `src/config.ts` |
| The page's heading and the line under it | `opening` in `src/config.ts` |
| Which calendars block booking | `BUSY_CALENDARS` in `wrangler.toml`, or for other accounts the push job's `--setup` |
| What the privacy page promises | `src/pages/privacy.astro` |

Keep a topic's `id` once you've shared its link (`/speaking`), because the
id is the URL. Push a change to `main` and Cloudflare deploys it.

## If booking stops working

The page says "Booking is offline for a moment" and offers your email. To find
the cause, watch the Worker's logs (`npx wrangler tail`), or open Workers &
Pages → **schedulum** → Logs in the dashboard:

- `auth: Google refused the refresh token`: access was revoked, or the app
  went back to Testing. Run `npm run connect-google` again and re-copy
  `GOOGLE_REFRESH_TOKEN`.
- `upstream: free/busy for …: notFound`: a calendar in `BUSY_CALENDARS` is
  gone or isn't shared with you. Schedulum fails closed rather than offering
  times it can't check.

- `upstream: synced busy times: …`: the Worker couldn't read the
  `SYNCED_BUSY` namespace. To turn the sync off in an emergency, run
  `npx wrangler secret delete BUSY_SYNC_SECRET`.

If times you're busy at work show as open, or the last days of the booking
window show nothing open, check the push job: on the server,
`journalctl --user -u schedulum-busy` shows each push or why it failed, and
the Worker logs `synced busy times are from …` once the last push is more than
six hours old.

If a visitor's note says "Couldn't send your note just now", the Worker logs
`schedulum: note not sent:` with Google's answer. A 403 has two causes, and
Google's answer says which. Either the Gmail API isn't enabled in the Cloud
project (step 1), or the sign-in predates the Gmail permission. For the
second, run `npm run connect-google` again, tick all three boxes, and re-copy
`GOOGLE_REFRESH_TOKEN`.

If every visitor instead sees "The spam check didn't go through", the
Turnstile keys don't match. Compare the widget's keys in the dashboard with
`.env.production` and the `TURNSTILE_SECRET_KEY` secret. To turn the check off
in an emergency, run `npx wrangler secret delete TURNSTILE_SECRET_KEY`. That
also turns notes off, since nothing else stands between them and your inbox.

To revoke Schedulum's access to your calendar and Gmail entirely, remove it at
<https://myaccount.google.com/permissions>.
