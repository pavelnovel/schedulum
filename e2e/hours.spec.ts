/**
 * Times on the visitor's clock, inside their own hours by default,
 * and a note to Pavel when none of them fit. Each test sets the browser's
 * time zone and stands in for Cloudflare's guess at the visitor's zone,
 * which the dev server can't give.
 */
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';

async function visit(
  browser: Browser,
  info: TestInfo,
  { tz, visitor = {}, path = '/ai-systems', init }: { tz: string; visitor?: { timeZone?: string }; path?: string; init?: () => void }
) {
  const context = await browser.newContext({ ...info.project.use, timezoneId: tz });
  const page = await context.newPage();
  if (init) await page.addInitScript(init);
  await page.route('**/api/slots*', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), visitor } });
  });
  await page.goto(path);
  await expect(page.locator('[data-cal-note]')).not.toHaveText(/Checking/);
  return { context, page };
}

const wide = () => test.info().project.name === 'desktop';
/** The notice as a visitor reads it: the sentence with the zone's name in place. */
const said = (page: Page) =>
  page.locator('[data-fit]').evaluate((el) => {
    const text = (sel: string) => el.querySelector(sel)!.textContent ?? '';
    return (text('[data-fit-before]') + text('[data-zone-label]') + text('[data-fit-after]')).trim();
  });
const unique = () => `guest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;

/** `2:30 PM late` → minutes after midnight. */
function minutesOf(text: string): number {
  const m = text.match(/(\d{1,2}):(\d\d)\s*([AP]M)/)!;
  return ((Number(m[1]) % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + Number(m[2]);
}

test('Tokyo: nothing in their hours, so the full schedule, said plainly, with a note one click away', async ({ browser }, info) => {
  const { context, page } = await visit(browser, info, { tz: 'Asia/Tokyo' });
  await expect
    .poll(() => said(page))
    .toBe(
      'You seem to be on Japan Standard Time. None of my open times fall between 9 AM and 7 PM for you, ' +
        'so here’s my full schedule. I know these are outside your working hours. ' +
        'If none of them work, send me a note and we’ll find a time.'
    );
  const write = page.locator('[data-fit]').getByRole('button', { name: 'Send me a note' });
  await expect(write).toBeVisible();
  await expect(write).toBeInViewport();
  await expect(page.locator('[data-hours-toggle]')).toBeHidden();
  await expect(page.locator('[data-note-line]')).toBeHidden();

  // Every open day is there, outlined, and every time says where it falls in their day.
  expect(await page.locator('[data-day]').count()).toBeGreaterThan(0);
  await expect(page.locator('button.day.is-outside').first()).toBeEnabled();
  if (!wide()) await page.locator('[data-day]').first().click();
  await expect(page.locator('[data-day][aria-pressed="true"]')).toHaveCount(1);
  const times = page.locator('.slot-time');
  await expect(times.first()).toBeVisible();
  await expect(page.locator('.slot-stamp')).toHaveCount(await times.count());
  await expect(page.locator('.slot-stamp').first()).toHaveText(/^(late|early|night)$/);
  await context.close();
});

test('a note reaches the host, and says so', async ({ browser }, info) => {
  const { context, page } = await visit(browser, info, { tz: 'Asia/Tokyo', path: '/speaking' });
  await page.locator('[data-fit]').getByRole('button', { name: 'Send me a note' }).click();
  await expect(page.locator('[data-pane="note"]')).toBeVisible();

  await page.getByRole('button', { name: 'Send note' }).click();
  await expect(page.locator('[data-note-error]')).toHaveText('Enter your name.');
  await page.locator('#n-name').fill('Night Owl');
  await page.locator('#n-email').fill('nope');
  await page.getByRole('button', { name: 'Send note' }).click();
  await expect(page.locator('[data-note-error]')).toHaveText('Enter a valid email address.');
  await page.locator('#n-email').fill('owl@example.com');
  await page.getByRole('button', { name: 'Send note' }).click();
  await expect(page.locator('[data-note-error]')).toHaveText('Write a line about what would work for you.');

  await page.getByLabel('What would work for you?').fill('Any weekday at 8 AM my time.');
  const [request] = await Promise.all([page.waitForRequest((r) => r.url().endsWith('/api/note')), page.getByRole('button', { name: 'Send note' }).click()]);
  const sent = JSON.parse(request.postData()!);
  expect(sent).toMatchObject({ name: 'Night Owl', email: 'owl@example.com', routeId: 'speaking', timeZone: 'Asia/Tokyo' });
  await expect(page.locator('[data-pane="noted"]')).toBeVisible();
  await expect(page.locator('[data-noted-text]')).toHaveText('Thanks, Night Owl. I’ll reply to owl@example.com.');
  await expect(page.locator('[data-live]')).toHaveText('Note sent.');

  // Back doesn't reopen a sent note.
  await page.goBack();
  await expect(page.locator('[data-pane="time"]')).toBeVisible();
  await context.close();
});

test('a visitor whose hours fit can still write instead', async ({ browser }, info) => {
  const { context, page } = await visit(browser, info, { tz: 'Europe/London', path: '/ai-answers' });
  const line = page.locator('[data-note-line]');
  await expect(line).toHaveText(/None of these work\?\s+Send me a note/);
  await expect(page.locator('[data-note-primary]')).toBeHidden();
  if (!wide()) await page.locator('[data-day]').first().click();
  // A name typed for a booking carries over to the note.
  await page.locator('.slot-time').first().click();
  await page.locator('#f-name').fill('Carried Over');
  await page.getByRole('button', { name: 'Change time' }).click();
  await line.getByRole('button', { name: 'Send me a note' }).click();
  await expect(page.locator('#n-name')).toHaveValue('Carried Over');
  await page.getByRole('button', { name: 'Back to the times' }).click();
  await expect(page.locator('[data-pane="time"]')).toBeVisible();
  await context.close();
});

test('Kolkata: a half-hour offset reads as one', async ({ browser }, info) => {
  const { context, page } = await visit(browser, info, { tz: 'Asia/Kolkata' });
  await expect.poll(() => said(page)).toContain('India Standard Time');
  await context.close();
});

test('London: only times that start at 9 AM or later and end by 7 PM', async ({ browser }, info) => {
  const { context, page } = await visit(browser, info, { tz: 'Europe/London' });
  await expect.poll(() => said(page)).toMatch(/^You seem to be on UK Time, so I’m showing times from 9 AM to 7 PM\.$/);
  await expect(page.locator('[data-hours-toggle]')).toHaveText('Show all times');
  const days = page.locator('[data-day]');
  const n = Math.min(await days.count(), 5);
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    await days.nth(i).click();
    for (const text of await page.locator('.slot-time').allTextContents()) {
      const start = minutesOf(text);
      expect(start).toBeGreaterThanOrEqual(9 * 60);
      expect(start + 30).toBeLessThanOrEqual(19 * 60);
    }
  }
  await context.close();
});

test('New York: every time already fits, so there is nothing to say but the zone', async ({ browser }, info) => {
  const { context, page } = await visit(browser, info, { tz: 'America/New_York', visitor: { timeZone: 'America/New_York' } });
  await expect.poll(() => said(page)).toMatch(/^Times are in your time zone, Eastern Time\.$/);
  await expect(page.locator('[data-hours-toggle]')).toBeHidden();
  await expect(page.locator('[data-fit-correction]')).toBeHidden();
  await context.close();
});

test('the notice names a time zone, never a place', async ({ browser }, info) => {
  for (const tz of ['Europe/London', 'Asia/Tokyo', 'America/New_York', 'Europe/Berlin']) {
    const { context, page } = await visit(browser, info, { tz });
    // What's written on the page; the full list of zones, behind the picker, has cities by design.
    const text = `${await said(page)} ${await page.locator('[data-fit-correction]').innerText()}`;
    expect(text, tz).not.toMatch(/London|Tokyo|New York|Berlin/);
    await context.close();
  }
});

test('a zone the visitor picks drops the guesswork', async ({ browser }, info) => {
  const { context, page } = await visit(browser, info, { tz: 'Asia/Tokyo' });
  await page.locator('[data-tz]').focus();
  await page.locator('[data-tz]').selectOption('Pacific/Auckland');
  await expect.poll(() => said(page)).toMatch(/in New Zealand Time/);
  await expect.poll(() => said(page)).not.toMatch(/seem/);
  await expect(page.locator('[data-tz]')).toBeFocused();
  await expect(page.locator('[data-live]')).toContainText('Time zone set to New Zealand Time');
  await context.close();
});

test('“Show all times” holds when the topic changes', async ({ browser }, info) => {
  test.skip(!wide());
  const { context, page } = await visit(browser, info, { tz: 'Europe/London' });
  await page.locator('[data-hours-toggle]').click();
  await expect.poll(() => said(page)).toMatch(/^Showing every time I have, in UK Time/);
  await page.locator('[data-topic="managing-agents"]').click();
  await expect.poll(() => said(page)).toMatch(/^Showing every time I have, in UK Time/);
  await page.getByRole('button', { name: 'Show only 9 AM to 7 PM' }).click();
  await expect.poll(() => said(page)).toMatch(/so I’m showing times from 9 AM to 7 PM\.$/);
  await context.close();
});

test.describe('Cloudflare’s guess at the zone', () => {
  test('on a VPN, keeps the device’s zone and offers the other in one click', async ({ browser }, info) => {
    const { context, page } = await visit(browser, info, { tz: 'Asia/Tokyo', visitor: { timeZone: 'Europe/Berlin' } });
    await expect.poll(() => said(page)).toMatch(/^You seem to be on Japan Standard Time/);
    const line = page.locator('[data-fit-correction]');
    await expect(line).toContainText(/Your connection suggests you might be on Central European Time\./);
    await expect(page.locator('[data-live]')).not.toContainText('Central European');
    await line.getByRole('button', { name: /^Switch to Central European Time/ }).click();
    await expect.poll(() => said(page)).toMatch(/in Central European Time/);
    await expect(line).toBeHidden();
    await expect.poll(() => said(page)).not.toMatch(/seem/);
    await context.close();
  });

  test('says nothing when the connection keeps the device’s clock', async ({ browser }, info) => {
    const { context, page } = await visit(browser, info, { tz: 'Asia/Kolkata', visitor: { timeZone: 'Asia/Calcutta' } });
    await expect(page.locator('[data-fit-correction]')).toBeHidden();
    await context.close();
  });

  test('offers the connection’s zone to a device left on UTC', async ({ browser }, info) => {
    const { context, page } = await visit(browser, info, { tz: 'UTC', visitor: { timeZone: 'Europe/Berlin' } });
    await expect.poll(() => said(page)).toContain('GMT+0');
    await expect(page.locator('[data-fit-correction]')).toContainText('Central European Time');
    await context.close();
  });

  test('shrugs off a zone that isn’t one', async ({ browser }, info) => {
    const { context, page } = await visit(browser, info, { tz: 'Asia/Tokyo', visitor: { timeZone: '<img src=x onerror=alert(1)>' } });
    await expect.poll(() => said(page)).toMatch(/^You seem to be on Japan Standard Time/);
    await expect(page.locator('[data-fit-correction]')).toBeHidden();
    await context.close();
  });

  test('goes by the connection when the device gives no zone, and by the host’s zone with neither', async ({ browser }, info) => {
    const noZone = () => {
      const original = Intl.DateTimeFormat.prototype.resolvedOptions;
      Intl.DateTimeFormat.prototype.resolvedOptions = function () {
        return { ...original.call(this), timeZone: undefined as unknown as string };
      };
    };
    const ip = await visit(browser, info, { tz: 'Asia/Tokyo', init: noZone, visitor: { timeZone: 'Europe/Berlin' } });
    await expect.poll(() => said(ip.page)).toMatch(/^I couldn’t read your device’s time zone, so I’m going by your connection\. Showing times from 9 AM to 7 PM in Central European Time/);
    await ip.context.close();

    const none = await visit(browser, info, { tz: 'Asia/Tokyo', init: noZone, visitor: {} });
    await expect.poll(() => said(none.page)).toMatch(/^I couldn’t tell your time zone, so these times are in mine\. Pick yours: Eastern Time/);
    await expect(none.page.locator('[data-hours-toggle]')).toBeHidden();
    expect(await none.page.locator('[data-day]').count()).toBeGreaterThan(0);
    await none.context.close();
  });
});

test('nothing about the visitor’s zone is kept: not in storage or the URL', async ({ browser }, info) => {
  const { context, page } = await visit(browser, info, { tz: 'Europe/Berlin', path: '/', visitor: { timeZone: 'Europe/Berlin' } });
  if (!wide()) await page.locator('[data-day]').first().click();
  await page.locator('.slot-time').first().click();
  await page.locator('#f-name').fill('Privacy Check');
  await page.locator('#f-email').fill(unique());
  await page.getByRole('button', { name: 'Book this time' }).click();
  await expect(page.getByRole('heading', { name: 'You’re booked.' })).toBeVisible();
  expect(page.url()).not.toMatch(/Berlin|tz=|zone=/);
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.filter((k) => k !== 'theme')).toEqual([]);

  // Leave the calendar as it was.
  const manage = new URL((await page.getByRole('link', { name: 'Reschedule or cancel' }).getAttribute('href'))!).pathname;
  await page.goto(manage);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel conversation' }).click();
  await expect(page.getByRole('heading', { name: 'Cancelled' })).toBeVisible();
  await context.close();
});

test('moving a booking made outside their hours starts with every time showing', async ({ browser }, info) => {
  const { context, page } = await visit(browser, info, { tz: 'Europe/London', path: '/ai-answers' });
  await page.locator('[data-hours-toggle]').click();
  // Find a time outside 9 AM to 7 PM: it carries a stamp.
  const days = page.locator('[data-day]');
  for (let i = 0, n = await days.count(); i < n; i++) {
    await days.nth(i).click();
    if (await page.locator('.slot-time:has(.slot-stamp)').count()) break;
  }
  await page.locator('.slot-time:has(.slot-stamp)').first().click();
  await page.locator('#f-name').fill('Late Bird');
  await page.locator('#f-email').fill(unique());
  await page.getByRole('button', { name: 'Book this time' }).click();
  await expect(page.getByRole('heading', { name: 'You’re booked.' })).toBeVisible();

  const manage = new URL((await page.getByRole('link', { name: 'Reschedule or cancel' }).getAttribute('href'))!).pathname;
  await page.goto(manage);
  await page.getByRole('button', { name: 'Reschedule' }).click();
  await expect.poll(() => said(page)).toMatch(/^You booked outside 9 AM to 7 PM, so I’m showing every time I have, in UK Time/);
  // On the US West Coast that same evening slot is early afternoon, so the reason no longer holds.
  await page.locator('[data-tz]').selectOption('America/Los_Angeles');
  await expect.poll(() => said(page)).not.toMatch(/You booked outside/);

  await page.goto(manage);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel conversation' }).click();
  await expect(page.getByRole('heading', { name: 'Cancelled' })).toBeVisible();
  await context.close();
});

test('the pane slides, and holds still for reduced motion', async ({ browser }, info) => {
  test.skip(!wide());
  const context = await browser.newContext({ ...info.project.use, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/ai-systems');
  await page.locator('.slot-time').first().click();
  const duration = await page.locator('[data-pane="details"]').evaluate((el) => parseFloat(getComputedStyle(el).animationDuration));
  expect(duration).toBeLessThanOrEqual(0.00001);
  await context.close();
});

test('the page never scrolls sideways on a phone', async ({ browser }, info) => {
  test.skip(wide());
  for (const tz of ['America/New_York', 'Europe/London', 'Asia/Tokyo', 'Pacific/Chatham']) {
    const { context, page } = await visit(browser, info, { tz, visitor: { timeZone: 'Europe/Berlin' } });
    const width = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(width[0], tz).toBeLessThanOrEqual(width[1]);
    await context.close();
  }
});

test('what was typed in the note carries back to the booking form', async ({ browser }, info) => {
  const { context, page } = await visit(browser, info, { tz: 'Europe/London', path: '/ai-answers' });
  await page.locator('[data-note-line]').getByRole('button', { name: 'Send me a note' }).click();
  await page.locator('#n-name').fill('Round Trip');
  await page.locator('#n-email').fill('round@example.com');
  await page.getByRole('button', { name: 'Back to the times' }).click();
  if (!wide()) await page.locator('[data-day]').first().click();
  await page.locator('.slot-time').first().click();
  await expect(page.locator('#f-name')).toHaveValue('Round Trip');
  await expect(page.locator('#f-email')).toHaveValue('round@example.com');
  await context.close();
});

test('changing topic while writing a note keeps the note', async ({ browser }, info) => {
  test.skip(!wide());
  const { context, page } = await visit(browser, info, { tz: 'Europe/London', path: '/ai-answers' });
  await page.locator('[data-note-line]').getByRole('button', { name: 'Send me a note' }).click();
  await page.locator('#n-text').fill('Thursdays are best.');
  await page.locator('[data-topic="speaking"]').click();
  await expect(page.locator('[data-pane="note"]')).toBeVisible();
  await expect(page.locator('#n-text')).toHaveValue('Thursdays are best.');
  await expect(page).toHaveURL(/\/speaking$/);
  await context.close();
});

test('a note still on its way doesn’t block a booking or pull the visitor back', async ({ browser }, info) => {
  const { context, page } = await visit(browser, info, { tz: 'Europe/London', path: '/' });
  await page.route('**/api/note', async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await page.locator('[data-note-line]').getByRole('button', { name: 'Send me a note' }).click();
  await page.locator('#n-name').fill('Two Tabs');
  await page.locator('#n-email').fill(unique());
  await page.locator('#n-text').fill('Either way works.');
  await page.getByRole('button', { name: 'Send note' }).click();
  await page.getByRole('button', { name: 'Back to the times' }).click();
  if (!wide()) await page.locator('[data-day]').first().click();
  await page.locator('.slot-time').first().click();
  await page.getByRole('button', { name: 'Book this time' }).click();
  await expect(page.getByRole('heading', { name: 'You’re booked.' })).toBeVisible();
  await expect(page.locator('[data-live]')).toHaveText(/Your note to .+ was sent\.|You’re booked\./, { timeout: 6000 });
  await page.waitForTimeout(3000);
  await expect(page.getByRole('heading', { name: 'You’re booked.' })).toBeVisible();

  const manage = new URL((await page.getByRole('link', { name: 'Reschedule or cancel' }).getAttribute('href'))!).pathname;
  await page.goto(manage);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel conversation' }).click();
  await context.close();
});

test('a note needs no topic either', async ({ browser }, info) => {
  const { context, page } = await visit(browser, info, { tz: 'Asia/Tokyo', path: '/' });
  await expect.poll(() => said(page)).toMatch(/send me a note and we’ll find a time\.$/);
  await page.locator('[data-note-primary]').click();
  await page.locator('#n-name').fill('No Topic');
  await page.locator('#n-email').fill('none@example.com');
  await page.locator('#n-text').fill('Evenings, my time.');
  const [request] = await Promise.all([page.waitForRequest((r) => r.url().endsWith('/api/note')), page.getByRole('button', { name: 'Send note' }).click()]);
  expect(JSON.parse(request.postData()!).routeId).toBeUndefined();
  await expect(page.locator('[data-pane="noted"]')).toBeVisible();
  await context.close();
});

test('Show all times under the list keeps the keyboard in the list', async ({ browser }, info) => {
  test.skip(!wide());
  const { context, page } = await visit(browser, info, { tz: 'Europe/London' });
  const days = page.locator('[data-day]');
  for (let i = 0, n = await days.count(); i < n; i++) {
    await days.nth(i).click();
    if (await page.locator('[data-hours-toggle-day]').isVisible()) break;
  }
  await page.locator('[data-hours-toggle-day]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(':focus')).toHaveClass(/slot-time|link/);
  await context.close();
});
