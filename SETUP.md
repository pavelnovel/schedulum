# Set up Schedulum

This guide takes a fork of Schedulum to a live booking page. Come back to it
to reconnect your calendar, change deploys, or find out why booking stopped.

The examples use `meet.example.com` for the page and `you@gmail.com` for the
Google account whose calendar takes bookings. Use your own.

Before you start, you need:

- Node.js 22.23.4 or later.
- A Google account. Bookings go on its primary calendar, and notes arrive in
  its Gmail inbox.
- A Cloudflare account. A domain on Cloudflare is optional.

## 1. Create the Google OAuth client

For one organizer, create a **Personal mode** project while signed in to the
Google account that will host meetings. Guests book on your page and receive
an invitation by email. Only the organizer signs into Google for Schedulum.
This works with either your own domain or a Cloudflare `workers.dev` address.

1. Open [Google’s Personal mode onboarding](https://console.cloud.google.com/auth/overview/personal).
   Create or select your Personal mode project, choose **Desktop app**, and
   save the client ID and secret when Google displays them.
2. In that same project, open the [API Library](https://console.cloud.google.com/apis/library)
   and enable **Google Calendar API** and **Gmail API**.
3. Continue to section 2 below. The desktop client uses a local callback during
   sign-in. You can use your assigned `workers.dev` hostname for the booking
   page without registering a custom domain for Google branding.

Personal mode limits consent to the project creator and has no seven-day
testing token expiry. Workspace administrators can restrict access to these
APIs. See [Google’s Personal mode guide](https://support.google.com/cloud/answer/15544987).

If you already use an OAuth client, keep it. For a separate organizer on
another Google account, create a Personal mode client under that account or
use an existing client whose audience includes it. For an External client,
enable both APIs, configure the consent screen and scopes, and use **In
production** for long-lived bookings. If Google requires branding-domain
verification for that setup, supply a domain you own. [Google’s audience settings](https://support.google.com/cloud/answer/15544987)
and [domain requirements](https://developers.google.com/identity/verification/authentication-policy-compliance).

## 2. Connect your calendar

Run these commands in your fork. Enter the Google client ID and secret when
prompted. If you already connected this checkout, the script reuses its saved
client settings.

```bash
npm ci
test -f .dev.vars || (umask 077 && cp .dev.vars.example .dev.vars)
npm run connect-google
```

Open the printed link and sign in as the account whose calendar takes
bookings. Personal mode requires the account that created the Google project.

Tick all three permissions:

- **View and edit events on all your calendars.** Schedulum reads only
  free/busy and changes only the events that it booked. No narrower
  permission lets it send invitations from your main calendar.
- **View your availability in your calendars.** This permission is the
  free/busy check.
- **Send email on your behalf.** This permission delivers a visitor's note to
  your own inbox, with the visitor as the reply-to. It can't read your mail.

The script checks that it can read your free/busy before it saves anything.
It saves the credentials in the gitignored `.dev.vars` file, with read and
write access only for your user. It generates a signing secret on first
connection. Reconnecting preserves your signing secret and calendar mode.

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
availability, change it to `google`. The dev server and local preview also default to fake when this setting is missing. A production build defaults to Google.

The spam check is off locally. `npm run dev` has no Turnstile key, and
`npm run preview` uses Cloudflare's always-pass test key. Neither has the
secret key, so the server accepts every booking. To try the check, give the
local Worker Cloudflare's always-pass test secret:

```bash
npm run preview -- --var TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA
```

> In `google` mode, a booking creates a real event and sends a real
> invitation, so use your own address as the guest. Local demo and preview manage links use the address you opened. Cancel test bookings from that local site.

## 4. Deploy to Cloudflare

### Choose the hostname and Turnstile keys before building

For a custom domain, set `routes` and `PUBLIC_URL` in `wrangler.toml`. To
use Cloudflare’s address, choose your account’s subdomain in **Workers &
Pages**, delete those two entries, and use
`schedulum.<your-subdomain>.workers.dev`. In either case, set `site` in
`astro.config.mjs` to the full HTTPS URL. [Cloudflare’s workers.dev guide](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).

In the Cloudflare dashboard, open **Turnstile** and add a **Managed** widget
for that exact hostname. Replace `PUBLIC_TURNSTILE_SITE_KEY` in
`.env.production` with its public site key **before** running
`npm run deploy`. Save the matching secret key in your credential store.
If you change the site key after a build, rebuild and deploy the page.

### Deploy the Worker and connect its secrets

Run `npx wrangler login` and confirm the selected account with
`npx wrangler whoami`.

For a personal calendar, remove the `[[kv_namespaces]]` block from
`wrangler.toml`. If you use the optional cross-account busy sync, run
`npx wrangler kv namespace create SYNCED_BUSY` and replace the example ID
with the ID it returns. Keep the `BOOKING_COORDINATOR` binding and migration.

```bash
npm run deploy
npx wrangler secret put TURNSTILE_SECRET_KEY
```

`npm run deploy` builds the site and runs `wrangler deploy`. The first deploy
creates the `schedulum` Worker and attaches your domain. When the domain's
zone is in the same Cloudflare account, Cloudflare creates the DNS record and
the certificate. Paste the widget’s matching secret at Wrangler’s prompt.

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

`dist/client` holds public assets. Wrangler deploys the server bundle separately and creates the `BOOKING_COORDINATOR` Durable Object on first deploy. Keep this binding and its migration when customizing the configuration.

### Deploy on every push

1. In the Cloudflare dashboard, open Workers & Pages → **schedulum** →
   Settings → Builds, and connect your GitHub repository.
2. The repository's `.nvmrc` selects Node.js 24. Use branch `main`, build
   command `npm run build`, and deploy command
   `npx wrangler deploy`.
3. Clear **Enable Preview builds**. Preview builds run with the real
   calendar's secrets.

After that, every push to `main` deploys. `npm run deploy` is then only for a
deploy from your own machine.

### Optional Spoiled NYC advertising organizer

A personal fork serves only the personal booking routes. The optional
`/spoiled-nyc` page is specific to Spoiled NYC. Connecting its separate
organizer enables the page and its booking API together. Existing
installations with all three organizer secrets stay enabled after an update.

For this integration, run `GOOGLE_ACCOUNT=you@work.example npm run connect-google -- --advertising`
with the work organizer’s Google account. If that account uses its own OAuth
client, provide its client ID and secret through the `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` environment variables for this command. Upload the
three `ADVERTISING_GOOGLE_` secrets using the commands it prints. Keep the
organizer connected while guests still need to manage work appointments.

To try the work page locally, set `CALENDAR_MODE=fake` and
`DEMO_ADVERTISING=true` in `.dev.vars` and restart the local server.
Playwright then exercises both organizers using fake appointments.

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

1. Replace `https://meet.example.com` with the HTTPS origin of your own
   booking site. Copy the script to the server and check the sign-ins. Setup
   saves the destination, token file paths, and a shared secret in
   `~/.config/schedulum/push.json` for the timer.

   ```bash
   ssh <server> 'mkdir -p ~/.config/schedulum'
   scp scripts/push-busy.mjs <server>:.config/schedulum/
   ssh <server> 'SCHEDULUM_URL=https://meet.example.com node ~/.config/schedulum/push-busy.mjs --setup /path/to/token.json'
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

- **When upgrading a sync job installed before v0.1**, run `SCHEDULUM_URL=https://meet.example.com node ~/.config/schedulum/push-busy.mjs --setup` on the server with your own origin. This reuses the saved accounts. The new script waits for this step before sending. Keeping the same destination preserves its secret. Changing destinations generates a fresh secret. Repeat step 2 for the new Worker.
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

## Update an existing fork

1. Check the live Worker’s **Deployments** and, for a Git-connected Worker,
   its **Builds**. Record the live version, source commit and production
   branch. In the fork, run `git remote -v` and `git status --short --branch`.
   Start from the fork branch containing the owner’s current settings. The
   example below uses `origin/main`. Commit any owner changes intended for
   the update on the appropriate fork branch first.
2. Choose a tag from [Schedulum releases](https://github.com/pavelnovel/schedulum/releases)
   and read its migration notes. Prepare the merge in a separate worktree.
   Substitute the tag you selected for the example value.

   ```bash
   release=v0.1.1
   git fetch origin
   git worktree add -b "update-schedulum-$release" "../schedulum-$release" origin/main
   cd "../schedulum-$release"
   git fetch --no-tags https://github.com/pavelnovel/schedulum.git "refs/tags/$release"
   git merge --no-ff --no-commit FETCH_HEAD
   git status --short
   git diff HEAD
   ```

3. Resolve any conflicts and stage the resolved files. Review the host’s
   identity, hours, topics, privacy copy, public URL, Turnstile site key,
   Worker name, routes and KV namespace. Incorporate new Durable Object
   migrations alongside the existing migration history. The live Worker
   already holds its Google, Turnstile, and signing secrets. Preserve the
   signing secret so guests can still use their existing private links.
4. Test the merged result in the new worktree with a fresh demo configuration.

   ```bash
   npm ci
   test -f .dev.vars || (umask 077 && cp .dev.vars.example .dev.vars)
   npm run check
   npm test
   npm run build
   npm run dev
   ```

   Confirm `CALENDAR_MODE=fake` before making test bookings. In a second
   terminal in the same worktree, run `npx playwright install chromium`
   and `npx playwright test`. If your fork changed the sample topics or
   copy, adapt the corresponding example tests. To exercise your personal
   booking flow on its own, run
   `npx playwright test --grep "book with no topic, then reschedule and cancel"`.
   It follows the private link returned by your local site.
5. Commit the reviewed merge, push the update branch to your fork, and
   merge it into the production branch when ready to deploy. If **Workers
   Builds** watches that branch, the merge starts deployment. For a manual
   deployment, run `npm run deploy` from the reviewed commit. Confirm the
   new deployment in Cloudflare, then run the [live booking checks](#5-check-it-end-to-end).
   If an update fails those checks, use the recorded version to check whether
   the migration supports Cloudflare’s [rollback procedure](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/).

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
