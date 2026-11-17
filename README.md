# Schedulum

Pavel's scheduling page, at `meet.pavelnovel.com`. It works like Calendly:
the calendar is the first thing a visitor sees, and nothing has to be chosen
before a time. Beside it, the things Pavel likes talking about are there to
pick from if the visitor wants to.

```text
Let's find a time to talk
→ pick a time from his real Google Calendar availability, on your clock,
  within your own 9 AM to 7 PM
→ name, email, and one optional question
  (pick a topic, and the question is that topic's)
→ calendar invite with a Google Meet link
→ a private link to reschedule or cancel
```

On a wide screen booking is one click to the form: a time. The topics sit in
the rail beside the calendar; on a phone they're a choice in the form. When
none of Pavel's open times fall in the visitor's working day, the page shows
the full schedule anyway, says so, and offers a note: a few lines that land in
his inbox, with the visitor to reply to.

## Status

Live at <https://meet.pavelnovel.com> since 2026-10-19, booking into
`pkonopl@gmail.com`'s primary calendar. Every push to `main` deploys.
[SETUP.md](SETUP.md) covers reconnecting the calendar and rebuilding the
setup.

## How it works

```text
Astro static pages (the booking page, one per topic, privacy)
  └─ src/scripts/booker.ts      the flow, calendar, and time picker
One Cloudflare Worker (serves the static pages as assets)
  ├─ GET  /api/slots            free slots for a conversation's length
  ├─ POST /api/book             spam check, re-checks the slot, creates the event
  ├─ POST /api/manage           reschedule or cancel by signed token
  ├─ POST /api/note             spam check, then a note to Pavel's Gmail
  ├─ PUT  /api/busy             busy times pushed from another server
  └─ GET  /manage/<token>       the guest's manage page
src/lib/
  ├─ availability.ts            working hours − busy blocks → slots (pure)
  ├─ hours.ts, fit.ts           the visitor's own hours, and what the page says about them (pure)
  ├─ booking.ts                 booking rules, independent of HTTP
  ├─ google.ts                  Google Calendar over fetch
  ├─ note.ts                    a visitor's note, sent through Gmail
  ├─ synced.ts                  adds the pushed busy times to Google's
  ├─ turnstile.ts               Cloudflare Turnstile verification
  └─ fake.ts                    in-memory calendar for dev and tests
scripts/push-busy.mjs           on a server: other accounts' free/busy → /api/busy
```

New bookings pass Cloudflare Turnstile, and one person can hold at most two
upcoming bookings (`+` aliases and Gmail dots count as the same address).

Google Calendar does the delivery: the invite email, updates, cancellations,
reminders, and the Meet link. The guest's name, email, and note go only into
the calendar event, or for a note only into one email to Pavel. The visitor's
time zone, and Cloudflare's guess at it from their IP address, choose what the
page shows; the zone they book in goes into the event. The one thing Schedulum
stores itself is the busy times
from Pavel's work calendar, which a job on his VPS reads from Google and
pushes every 10 minutes.

Everything Pavel is likely to edit (hours, meeting length, topics, copy) is in
[`src/config.ts`](src/config.ts).

## Develop

```bash
npm install
cp .dev.vars.example .dev.vars   # CALENDAR_MODE=fake: no real calendar
npm run dev                      # http://localhost:4321
npm test                         # unit tests: availability, timezones, visitor hours, booking, notes, Google, Turnstile, sync
npx playwright test              # browser tests, including axe checks (dev server must be running)
```

## Run your own

Fork it, then change what's Pavel's:

- `src/config.ts`: your name and links, working hours, and topics.
- `wrangler.toml`: your domain and `PUBLIC_URL`, or delete both to serve
  from `schedulum.<your-subdomain>.workers.dev`, which needs no domain at
  all. Also your KV namespace ID, or drop the `[[kv_namespaces]]` block if you
  won't sync other calendars.
- `astro.config.mjs`: `site`, your public address.
- `.env.production`: the site key of your own Turnstile widget.
- `src/pages/privacy.astro`: your own privacy page.

[SETUP.md](SETUP.md) walks through Pavel's setup step by step: the Google
OAuth client, the Cloudflare Worker, Turnstile, and the optional job that
pushes busy times from other accounts. Use your own names where it uses his.

Google Calendar is the only calendar it talks to so far. The rest of the app
only needs the `Calendar` interface in
[`src/lib/calendar.ts`](src/lib/calendar.ts), so another provider, such as
Outlook or CalDAV, is a new file beside `src/lib/google.ts`, chosen in
`src/lib/env.ts`.

## License

[MIT](LICENSE)
