# Set up Schedulum

This guide takes a fork of Schedulum to a live booking page. Come back to it
to reconnect your calendar, change deploys, or find out why booking stopped.

The examples use `meet.example.com` for the page and `you@gmail.com` for the
Google account whose calendar takes bookings. Use your own.

Before you start, you need:

- Node.js 22 or later.
- A Google account. Bookings go on its primary calendar, and notes arrive in
  its Gmail inbox.
- A Cloudflare account. A domain on Cloudflare is optional.

## 1. Create the Google OAuth client

1. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project named **Schedulum**.
2. Enable the **Google Calendar API** and the **Gmail API**: APIs & Services
   → Library → each one → Enable. Gmail is only for sending visitors' notes
   to you.
3. In Google Auth Platform, choose **Get started**:
   - App name: **Schedulum**
   - User support and developer contact email: your address
   - Audience: **External**
   - Agree to the Google API Services User Data Policy.
4. Under **Data Access**, add these three scopes and save:
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/calendar.freebusy`
   - `https://www.googleapis.com/auth/gmail.send`
5. Under **Branding**, fill in the fields that Google requires before you can
   publish, then save:
   - Application home page: `https://meet.example.com`
   - Application privacy policy link: `https://meet.example.com/privacy`
   - Authorized domain: `example.com`
6. Under **Audience**, select **Publish app**, then **Confirm**, to move the
   app to **In production**. Google then says that the app "requires
   verification". You can ignore that message, because verification is for
   apps that other people sign in to.

   > **Don't skip this step.** In Testing, Google expires refresh tokens after
   > seven days, and booking then stops without warning. An unverified
   > production app that only you sign in to is allowed.

7. Under **Clients**, create an OAuth client with application type **Desktop
   app**, named `Schedulum`. Google shows the client secret only once, in the
   dialog that follows, so copy the client ID and secret before you close it.

## 2. Connect your calendar

Put the client ID and secret in `.dev.vars` as `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET`, or paste them when the script asks. Then run:

```bash
npm install
npm run connect-google
```

Open the printed link and sign in as the account whose calendar takes
bookings. At "Google hasn't verified this app", check that the developer email
shown is yours, then choose **Advanced** → **Go to Schedulum (unsafe)**.

Tick all three permissions:

- **View and edit events on all your calendars.** Schedulum reads only
  free/busy and changes only the events that it booked. No narrower
  permission lets it send invitations from your main calendar.
- **View your availability in your calendars.** This permission is the
  free/busy check.
- **Send email on your behalf.** This permission delivers a visitor's note to
  your own inbox, with the visitor as the reply-to. It can't read your mail.

The script checks that it can read your free/busy before it saves anything.
It writes the credentials and a fresh `SIGNING_SECRET` to `.dev.vars`, which
git ignores, and it never prints the refresh token.

To make other calendars on the same account block booking, such as a shared
family calendar, put their IDs in `BUSY_CALENDARS` in `wrangler.toml`,
separated by commas:

```toml
BUSY_CALENDARS = "primary,family123@group.calendar.google.com"
```

For calendars on other Google accounts, such as a work calendar, see
[Work calendars from another server](#work-calendars-from-another-server).

## 3. Try it locally

```bash
npm run dev       # http://localhost:4321, Astro's dev server
npm run preview   # http://localhost:8787, the Workers runtime
```

`.dev.vars` starts with `CALENDAR_MODE=fake`: an in-memory calendar with
made-up busy blocks that's safe to click through. To see your real
availability, change it to `google`. Production has no `CALENDAR_MODE`, which
means `google`.

The spam check is off locally. `npm run dev` has no Turnstile key, and
`npm run preview` uses Cloudflare's always-pass test key. Neither has the
secret key, so the server accepts every booking. To try the check, give the
local Worker Cloudflare's always-pass test secret:

```bash
npm run preview -- --var TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA
```

> In `google` mode, a booking creates a real event and sends a real
> invitation, so use your own address as the guest. Manage links point at
> `PUBLIC_URL`, which is `localhost` in `.dev.vars`, so cancel test bookings
> from the local site.

## 4. Deploy to Cloudflare

Set your domain in `wrangler.toml`, both in `routes` and in `PUBLIC_URL`. If
you don't have a domain on Cloudflare, delete both lines, and the page runs at
`schedulum.<your-subdomain>.workers.dev`.

Create the namespace that holds pushed busy times, and put its ID in the
`[[kv_namespaces]]` block. If you won't push busy times from another server,
delete that block instead.

```bash
npx wrangler login
npx wrangler kv namespace create SYNCED_BUSY
npm run deploy
```

`npm run deploy` builds the site and runs `wrangler deploy`. The first deploy
creates the `schedulum` Worker and attaches your domain. When the domain's
zone is in the same Cloudflare account, Cloudflare creates the DNS record and
the certificate.

Copy the secrets from `.dev.vars` to the Worker. This command sends all four
at once and prints none of them:

```bash
node -e "const fs=require('fs');const v={};for(const l of fs.readFileSync('.dev.vars','utf8').split('\n')){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m)v[m[1]]=m[2]}process.stdout.write(JSON.stringify(Object.fromEntries(['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN','SIGNING_SECRET'].map(k=>[k,v[k]]))))" | npx wrangler secret bulk
```

After you reconnect your calendar, only `GOOGLE_REFRESH_TOKEN` changes:

```bash
grep '^GOOGLE_REFRESH_TOKEN=' .dev.vars | cut -d= -f2- | npx wrangler secret put GOOGLE_REFRESH_TOKEN
```

Keep `SIGNING_SECRET` once guests have manage links. The links are signed
with it, so a new secret breaks every reschedule or cancel link sent so far.

`public/.assetsignore` keeps the server bundle (`_worker.js`) out of the
public files. Don't remove it.

### Deploy on every push

1. In the Cloudflare dashboard, open Workers & Pages → **schedulum** →
   Settings → Builds, and connect your GitHub repository.
2. Use branch `main`, build command `npm run build`, and deploy command
   `npx wrangler deploy`.
3. Clear **Enable Preview builds**. Preview builds run with the real
   calendar's secrets.

After that, every push to `main` deploys. `npm run deploy` is then only for a
deploy from your own machine.

### The spam check (Turnstile)

Bookings and notes must pass Cloudflare Turnstile. Most visitors never see
it, and it asks for a click only when it isn't sure.

1. In the Cloudflare dashboard, open Application security → Turnstile →
   **Add widget**. Name it `Schedulum`, add your page's hostname, keep
   **Managed** mode, and create the widget.
2. Put the site key in `.env.production` as `PUBLIC_TURNSTILE_SITE_KEY`. The
   site key is public and committed, and the build puts it in the page.
3. Store the secret key in the Worker:

   ```bash
   npx wrangler secret put TURNSTILE_SECRET_KEY
   ```

The two keys work only as a pair. With the secret set, a missing site key or a
key from another widget makes every booking fail with "The spam check didn't
go through".

### Spoiled NYC advertising organizer

Set `GOOGLE_ACCOUNT` to the work email and run `npm run connect-google -- --advertising` to connect its Google Calendar.
After approving Calendar access, follow the printed commands to upload the three `ADVERTISING_GOOGLE_` secrets.

### Optional: a message when someone books

Google doesn't notify you about events that Schedulum creates on your behalf.
To get a one-line message for every booking, reschedule, and cancellation, set
`NOTIFY_WEBHOOK_URL` to an endpoint that accepts `{"text": "..."}`, such as a
Slack incoming webhook:

```bash
npx wrangler secret put NOTIFY_WEBHOOK_URL
```

### Work calendars from another server

Schedulum's Google connection reads only the calendars that your account can
see. For calendars on other Google accounts, a job on an always-on server
that's signed in to them sends their busy times, without titles, every 10
minutes.

The job needs Node 18 or later. Each account is a token file in Google's
authorized-user format (`client_id`, `client_secret`, `refresh_token`), as
Google's own libraries save it. The job only reads these files.

1. Copy the script to the server and check the sign-ins. This step saves
   them, with a new shared secret, in `~/.config/schedulum/push.json` on the
   server:

   ```bash
   ssh <server> 'mkdir -p ~/.config/schedulum'
   scp scripts/push-busy.mjs <server>:.config/schedulum/
   ssh <server> 'node ~/.config/schedulum/push-busy.mjs --setup /path/to/token.json'
   ```

2. Give the Worker the same secret. The secret passes straight through and is
   never printed:

   ```bash
   ssh <server> 'node ~/.config/schedulum/push-busy.mjs --secret' | npx wrangler secret put BUSY_SYNC_SECRET
   ```

3. Check what the job sends, send once, then install the timer:

   ```bash
   ssh <server> 'node ~/.config/schedulum/push-busy.mjs --dry-run'
   ssh <server> 'node ~/.config/schedulum/push-busy.mjs'
   ssh <server> 'node ~/.config/schedulum/push-busy.mjs --install'
   ```

`--install` adds a systemd user timer named `schedulum-busy`. To see its log,
run `journalctl --user -u schedulum-busy`. The timer runs while you're logged
out only if lingering is on for that user (`loginctl enable-linger`).

- **To change accounts**, run `--setup` again with the new token files. The
  secret stays the same.
- **After you update the script or change Node versions**, copy the script
  again and run `--install` again.
- **To stop the job**, run `--uninstall` on the server, then
  `npx wrangler secret delete BUSY_SYNC_SECRET`. Without the secret, the site
  ignores the busy times that it stored. If you only uninstall, the site keeps
  using the last push and blocks every day past the 30 days that it covered.

The site knows only what the last push said, so a meeting added in the last
10 minutes can still be booked over. Days past the 30 that the last push
covered count as busy, so a job that stops shortens the booking window rather
than opening it up.

If an account can't be read, for example because its sign-in was revoked, the
job keeps sending the others. That account keeps its last good busy times for
three days and then stops counting, and each run's log line names it.

## 5. Check it end to end

1. Open your page and book a time with your own address as the guest. A `+`
   alias such as `you+test@gmail.com` lands in your own inbox.
2. Check that the event is on your calendar with a Meet link, and that the
   invitation arrived.
3. Open **Reschedule or cancel** from the invitation, move the meeting, and
   then cancel it. Both changes reach your calendar and your inbox.
4. Add a test event to your calendar and reload the page. Those times
   disappear.
5. Choose **Send me a note** and send one to yourself. It arrives in your
   inbox, from your own address.

## Change things later

| To change | Edit |
| --- | --- |
| Working hours, buffers, notice, horizon, and daily cap | `availability` in `src/config.ts` |
| The visitor's hours offered by default (9 AM to 7 PM their time) | `visitorHours` in `src/config.ts` |
| Meeting length, and the question asked when no topic is picked | `meeting` in `src/config.ts` |
| Topics, their copy and question, and a topic's own length if it differs | `routes` in `src/config.ts` |
| The page's heading and the line under it | `opening` in `src/config.ts` |
| Which calendars block booking | `BUSY_CALENDARS` in `wrangler.toml`, or the push job's `--setup` for other accounts |
| What the privacy page says | `src/pages/privacy.astro` |

Keep a topic's `id` after you share its link, because the ID is the URL
(`/speaking`). If you remove a topic whose link is out, add a redirect for it
in `astro.config.mjs`.

## If booking stops working

The page says "Booking is offline for a moment" and offers your email
address. To find the cause, watch the Worker's logs with `npx wrangler tail`,
or open Workers & Pages → **schedulum** → Logs in the dashboard.

| Log line | Cause and fix |
| --- | --- |
| `auth: Google refused the refresh token` | Access was revoked, or the app went back to Testing. Run `npm run connect-google` again and copy `GOOGLE_REFRESH_TOKEN` to the Worker. |
| `upstream: free/busy for …: notFound` | A calendar in `BUSY_CALENDARS` is gone or isn't shared with you. Schedulum fails closed rather than offering times that it can't check. |
| `upstream: synced busy times: …` | The Worker couldn't read the `SYNCED_BUSY` namespace. To turn the sync off in an emergency, run `npx wrangler secret delete BUSY_SYNC_SECRET`. |

If times when you're busy at work show as open, or the last days of the
booking window show nothing open, check the push job. On the server,
`journalctl --user -u schedulum-busy` shows each push or why it failed. Once
the last push is more than six hours old, the Worker logs
`synced busy times are from …`.

If a visitor's note fails with "Couldn't send your note just now", the Worker
logs `schedulum: note not sent:` with Google's answer. A 403 has two causes,
and Google's answer says which. Either the Gmail API isn't enabled in the
Cloud project (step 1), or the sign-in predates the Gmail permission. For the
second cause, run `npm run connect-google` again, tick all three permissions,
and copy `GOOGLE_REFRESH_TOKEN` to the Worker.

If every visitor sees "The spam check didn't go through", the Turnstile keys
don't match. Compare the widget's keys in the dashboard with `.env.production`
and the `TURNSTILE_SECRET_KEY` secret. To turn the check off in an emergency,
run `npx wrangler secret delete TURNSTILE_SECRET_KEY`. That also turns off
notes, because nothing else stands between them and your inbox.

To revoke Schedulum's access to your calendar and Gmail, remove it at
<https://myaccount.google.com/permissions>.
