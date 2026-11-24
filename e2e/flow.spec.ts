import { expect, test, type Page } from '@playwright/test';

const shots = process.env.SHOTS_DIR;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${test.info().project.name}-${name}.png`, fullPage: true });
};
const unique = () => `guest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
const wide = () => test.info().project.name === 'desktop';

/** On the calendar: a wide screen already has a day open; a phone picks one. */
async function pickFirstTime(page: Page) {
  if (!wide()) {
    const day = page.locator('[data-day]').first();
    await expect(day).toBeVisible();
    await day.click();
  }
  await expect(page.locator('.slot-time').first()).toBeVisible();
  await page.locator('.slot-time').first().click();
  await expect(page.locator('[data-pane="details"], [data-pane="confirm"]').first()).toBeVisible();
}

/** A topic, the way each width offers it: the rail beside the calendar, or the select in the form. */
async function pickTopic(page: Page, id: string) {
  if (wide()) await page.locator(`[data-topic="${id}"]`).click();
  else await page.locator('[data-topic-select]').selectOption(id);
}

test('book with no topic, then reschedule and cancel', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 }).filter({ visible: true })).toHaveText('Let’s find a time to talk');
  await page.waitForTimeout(700);
  await shot(page, '01-landing');

  await pickFirstTime(page);
  await expect(page.locator('[data-when-text]')).toContainText(/\d:\d\d [AP]M – /);
  await page.locator('#f-name').fill('Ada Lovelace');
  await page.locator('#f-email').fill(unique());
  await page.getByLabel(/What’s on your mind\?/).fill('Engines that weave algebraic patterns.');
  await shot(page, '02-details');

  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith('/api/book')),
    page.getByRole('button', { name: 'Book this time' }).click(),
  ]);
  expect(JSON.parse(request.postData()!).routeId).toBeUndefined();
  await expect(page.getByRole('heading', { name: 'You’re booked.' })).toBeVisible();
  await expect(page.locator('[data-done-facts]')).toContainText('A conversation');
  await page.waitForTimeout(1300);
  await shot(page, '03-booked');

  // Reschedule through the manage link.
  // Follow the link's path on the server under test; PUBLIC_URL may name another origin.
  const manage = new URL((await page.getByRole('link', { name: 'Reschedule or cancel' }).getAttribute('href'))!).pathname;
  expect(manage).toMatch(/\/manage\/[0-9a-v]{26}\./);
  await page.goto(manage!);
  await expect(page.getByRole('heading', { name: /Your conversation with Pavel/ })).toBeVisible();
  await expect(page.locator('[data-overview-facts]')).toContainText('A conversation');
  await shot(page, '04-manage');

  await page.getByRole('button', { name: 'Reschedule' }).click();
  const days = page.locator('[data-day]');
  await expect(days.nth(1)).toBeVisible();
  await days.nth(1).click();
  // A time goes straight to the confirmation, which is what sends the emails.
  await page.locator('.slot-time').first().click();
  await expect(page.getByRole('heading', { name: 'Move your conversation' })).toBeVisible();
  await shot(page, '05-confirm-move');
  await page.getByRole('button', { name: 'Reschedule', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Moved.' })).toBeVisible();
  await expect(page.locator('[data-done-facts]')).toContainText('30 min');

  // Then cancel it.
  await page.goto(manage!);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel conversation' }).click();
  await expect(page.getByRole('heading', { name: 'Cancelled' })).toBeVisible();

  await page.goto(manage!);
  await expect(page.getByRole('heading', { name: 'Nothing to change here' })).toBeVisible();
});

test('book with a topic, which sharpens the question and travels with the booking', async ({ page }) => {
  await page.goto('/');
  if (wide()) await pickTopic(page, 'ai-systems');
  await pickFirstTime(page);
  if (!wide()) await pickTopic(page, 'ai-systems');
  await expect(page).toHaveURL(/\/ai-systems$/);
  await page.locator('#f-name').fill('Grace Hopper');
  await page.locator('#f-email').fill(unique());
  await page.getByLabel(/What are you building/).fill('A compiler.');
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith('/api/book')),
    page.getByRole('button', { name: 'Book this time' }).click(),
  ]);
  expect(JSON.parse(request.postData()!)).toMatchObject({ routeId: 'ai-systems', note: 'A compiler.' });
  await expect(page.locator('[data-done-facts]')).toContainText('Building useful AI systems');

  const manage = new URL((await page.getByRole('link', { name: 'Reschedule or cancel' }).getAttribute('href'))!).pathname;
  await page.goto(manage);
  await expect(page.locator('[data-overview-facts]')).toContainText('Building useful AI systems');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel conversation' }).click();
  await expect(page.getByRole('heading', { name: 'Cancelled' })).toBeVisible();
});

test('Spoiled advertisers book on the shared calendar with a fixed meeting type', async ({ page }) => {
  await page.goto('/spoiled-nyc');
  await expect(page.getByRole('heading', { name: 'Book a meeting with spoiled NYC' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'spoiled NYC', exact: true })).toHaveAttribute('href', 'https://spoilednyc.com/advertise');
  await expect(page.getByRole('link', { name: 'advertise@spoiledmedia.com' })).toBeVisible();
  await expect(page.locator('[data-topic], [data-topic-select]')).toHaveCount(0);

  await pickFirstTime(page);
  await page.getByLabel('Name', { exact: true }).fill('Ada Lovelace');
  await page.getByLabel('Email', { exact: true }).fill(unique());
  await page.getByLabel(/What are you planning for your brand/).fill('A restaurant opening.');

  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith('/api/book')),
    page.getByRole('button', { name: 'Book this time' }).click(),
  ]);
  const booking = request.postDataJSON();
  expect(booking).toMatchObject({ routeId: 'spoiled-nyc', note: 'A restaurant opening.' });
  await expect(page.locator('[data-done-facts]')).toContainText('spoiled NYC advertising');
  const personalSlots = await page.request.get('/api/slots');
  expect(personalSlots.ok()).toBe(true);
  expect((await personalSlots.json()).slots).not.toContain(booking.start);

  const manage = new URL((await page.getByRole('link', { name: 'Reschedule or cancel' }).getAttribute('href'))!).pathname;
  await page.goto(manage);
  await expect(page.locator('[data-overview-facts]')).toContainText('spoiled NYC advertising');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel conversation' }).click();
  await expect(page.getByRole('link', { name: 'pick a new time' })).toHaveAttribute('href', '/spoiled-nyc');
});

test('on a wide screen, landing to the details form is one click', async ({ page }) => {
  test.skip(!wide());
  await page.goto('/');
  // Nothing to choose first: the calendar works, a day is open, no topic is pressed.
  await expect(page.locator('[data-day][aria-pressed="true"]')).toHaveCount(1);
  await expect(page.locator('[data-picker]')).toHaveJSProperty('inert', false);
  await expect(page.locator('[data-topic][aria-pressed="true"]')).toHaveCount(0);
  await expect(page.getByText(/Choose a topic/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Find a time', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Find a time|Next)$/ })).toHaveCount(0);
  await expect(page.getByText('Something else entirely')).toHaveCount(0);
  await expect(page.locator('[data-topic]')).toHaveCount(4);

  await page.locator('.slot-time').first().click(); // 1
  await expect(page.locator('[data-pane="details"]')).toBeVisible();
  await expect(page.locator('#f-name')).toBeFocused();
  // The rail beside the form is the topic choice, so the form doesn't ask again.
  await expect(page.locator('[data-topic-select]')).toBeHidden();
});

test('on a phone, landing to the details form is two taps', async ({ page }) => {
  test.skip(wide());
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Let’s find a time to talk' })).toBeVisible();
  await expect(page.locator('[data-topic]').filter({ visible: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Potential topics' })).toHaveCount(0);
  await expect(page.locator('[data-day]').first()).toBeInViewport();
  await expect(page.locator('[data-day][aria-pressed="true"]')).toHaveCount(0);

  await page.locator('[data-day]').first().click(); // 1
  await page.locator('.slot-time').first().click(); // 2
  await expect(page.locator('[data-pane="details"]')).toBeVisible();

  // The topic is offered in the form, between the email and the question, and left alone it stays unset.
  const order = await page
    .locator('[data-pane="details"]')
    .evaluate((form) => [...form.querySelectorAll('#f-email, #f-topic, #f-note')].map((el) => el.id));
  expect(order).toEqual(['f-email', 'f-topic', 'f-note']);
  await expect(page.locator('[data-topic-select]')).toHaveValue('');
  await expect(page.locator('label[for="f-note"]')).toContainText('What’s on your mind?');
  await expect(page.locator('[data-topic-hint]')).toBeHidden();
});

test('a topic link arrives with that topic picked, one choice away from none', async ({ page }) => {
  await page.goto('/speaking');
  if (wide()) {
    await expect(page.locator('[data-topic="speaking"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#rail-speaking')).toBeVisible();
  }
  await pickFirstTime(page);
  await expect(page.locator('label[for="f-note"]')).toContainText('The event or show');
  if (!wide()) {
    await expect(page.locator('[data-topic-select]')).toHaveValue('speaking');
    await expect(page.locator('[data-topic-hint]')).toContainText('Conference talks');
    await page.locator('[data-topic-select]').selectOption('');
    await expect(page.locator('label[for="f-note"]')).toContainText('What’s on your mind?');
    await expect(page).toHaveURL(/\/$/);
  }
});

test('a removed topic’s old link lands on the page', async ({ page }) => {
  await page.goto('/something-else');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Let’s find a time to talk' })).toBeVisible();
});

test('a rail topic toggles, names itself in the address, and adds no history', async ({ page }) => {
  test.skip(!wide());
  await page.goto('/');
  await expect(page.locator('.slot-time').first()).toBeVisible();
  const lookups: string[] = [];
  page.on('request', (r) => r.url().includes('/api/slots') && lookups.push(r.url()));
  const entries = await page.evaluate(() => history.length);

  const topic = page.locator('[data-topic="ai-answers"]');
  await topic.click();
  await expect(topic).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#rail-ai-answers')).toBeVisible();
  await expect(page).toHaveURL(/\/ai-answers$/);
  await expect(page.locator('[data-live]')).toHaveText('How brands show up in AI answers selected.');
  // Same length, so the same times: nothing to look up again, and the open day stays open.
  await expect(page.locator('[data-day][aria-pressed="true"]')).toHaveCount(1);

  await page.locator('[data-topic="speaking"]').click();
  await expect(topic).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-topic][aria-pressed="true"]')).toHaveCount(1);

  await page.locator('[data-topic="speaking"]').click();
  await expect(page.locator('[data-topic][aria-pressed="true"]')).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('[data-live]')).toHaveText('Topic cleared.');

  expect(await page.evaluate(() => history.length)).toBe(entries);
  expect(lookups).toEqual([]);
});

test('changing topic on the details form keeps the time and what was typed', async ({ page }) => {
  await page.goto('/');
  await pickFirstTime(page);
  const when = await page.locator('[data-when-text]').textContent();
  await page.locator('#f-name').fill('Kept Name');
  await pickTopic(page, 'speaking');
  await expect(page.locator('[data-pane="details"]')).toBeVisible();
  await expect(page.locator('[data-when-text]')).toHaveText(when!);
  await expect(page.locator('#f-name')).toHaveValue('Kept Name');
  await expect(page.locator('label[for="f-note"]')).toContainText('The event or show');
  await expect(page.locator('#f-note')).toHaveAttribute('placeholder', 'Name, rough date, audience.');
  await expect(page).toHaveURL(/\/speaking$/);

  if (wide()) await page.locator('[data-topic="speaking"]').click();
  else await page.locator('[data-topic-select]').selectOption('');
  await expect(page.locator('label[for="f-note"]')).toContainText('What’s on your mind?');
  await expect(page.locator('#f-note')).toHaveAttribute('placeholder', 'Anything that helps me show up prepared.');
});

test('Back from the details returns to the chosen time, and the topic stays as left', async ({ page }) => {
  await page.goto('/');
  await pickFirstTime(page);
  await pickTopic(page, 'managing-agents');
  await page.goBack();
  await expect(page.locator('[data-pane="time"]')).toBeVisible();
  await expect(page.locator('.slot[data-selected] .slot-time')).toBeFocused();
  await expect(page).toHaveURL(/\/managing-agents$/);
  if (wide()) await expect(page.locator('[data-topic="managing-agents"]')).toHaveAttribute('aria-pressed', 'true');

  await page.goForward();
  await expect(page.locator('[data-pane="details"]')).toBeVisible();
  await expect(page.locator('label[for="f-note"]')).toContainText('What does your team look like today?');
  await expect(page).toHaveURL(/\/managing-agents$/);
  if (!wide()) await expect(page.locator('[data-topic-select]')).toHaveValue('managing-agents');
});

test('the topic holds when the window narrows and widens', async ({ page }) => {
  test.skip(!wide());
  await page.goto('/');
  await page.locator('.slot-time').first().click();
  await page.locator('#f-name').fill('Resized');
  await page.locator('[data-topic="ai-answers"]').click();
  await page.setViewportSize({ width: 600, height: 860 });
  await expect(page.locator('[data-topic-select]')).toBeVisible();
  await expect(page.locator('[data-topic-select]')).toHaveValue('ai-answers');
  await page.locator('[data-topic-select]').selectOption('managing-agents');
  await page.setViewportSize({ width: 1280, height: 860 });
  await expect(page.locator('[data-topic="managing-agents"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#f-name')).toHaveValue('Resized');
  await expect(page.locator('label[for="f-note"]')).toContainText('What does your team look like today?');
  await expect(page).toHaveURL(/\/managing-agents$/);
});

test('Change time goes back to the calendar', async ({ page }) => {
  await page.goto('/ai-answers');
  await pickFirstTime(page);
  await page.getByRole('button', { name: 'Change time' }).click();
  await expect(page.locator('[data-pane="time"]')).toBeVisible();
  await expect(page.locator('.slot[data-selected]')).toHaveCount(1);
});

test('the whole flow works from the keyboard', async ({ page }) => {
  test.skip(!wide());
  await page.goto('/');
  await expect(page.locator('.slot-time').first()).toBeVisible();
  // The topics are toggles: Space presses one and the focus stays put.
  await expect(page.getByRole('group', { name: 'Potential topics' })).toBeVisible();
  const first = page.locator('[data-topic]').first();
  await first.focus();
  await page.keyboard.press('Space');
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(first).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-topic]').nth(1)).toBeFocused();

  await page.locator('[data-day][aria-pressed="true"]').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.locator('.slot-time').first()).toBeVisible();
  await page.locator('.slot-time').first().focus();
  await page.keyboard.press('Enter');

  await expect(page.locator('#f-name')).toBeFocused();
  await page.keyboard.type('Grace Hopper');
  await page.keyboard.press('Tab');
  await page.keyboard.type(unique());
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'You’re booked.' })).toBeVisible();
});

test('a topic with a length of its own gets times that fit it', async ({ page }) => {
  // Stand in for a config where talks run an hour: the page's boot data, and the times for that length.
  await page.route(/\/$/, async (route) => {
    const res = await route.fetch();
    const html = (await res.text()).replace(/(data-boot[^>]*>)([\s\S]*?)(<\/script>)/, (_, open: string, json: string, close: string) => {
      const boot = JSON.parse(json);
      boot.routes.find((r: { id: string }) => r.id === 'speaking').minutes = 60;
      return open + JSON.stringify(boot) + close;
    });
    await route.fulfill({ response: res, body: html });
  });
  let firstTime = '';
  await page.route('**/api/slots?route=speaking', async (route) => {
    const res = await route.fetch({ url: route.request().url().replace('?route=speaking', '') });
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, minutes: 60, slots: body.slots.filter((s: string) => s !== firstTime) } });
  });

  await page.goto('/');
  await pickFirstTime(page);
  firstTime = await page.evaluate(() => history.state.time);

  const [lookup] = await Promise.all([page.waitForRequest((r) => r.url().includes('/api/slots?route=speaking')), pickTopic(page, 'speaking')]);
  expect(lookup).toBeTruthy();
  await expect(page.locator('[data-pane="time"]')).toBeVisible();
  await expect(page.locator('[data-cal-note]')).toHaveText('That time doesn’t fit a 60-minute conversation. Pick another.');
  await expect(page.locator('.slot[data-selected]')).toHaveCount(0);
  // The focus doesn't fall out of the page with the form it was in.
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');

  // Booking another time takes the topic's length.
  await pickFirstTime(page);
  await expect(page.locator('[data-when-text]')).toContainText(/(\d+):(\d\d) [AP]M – /);
  const [start, end] = (await page.locator('[data-when-text]').textContent())!.match(/\d+:\d\d [AP]M/g)!;
  const toMinutes = (t: string) => {
    const [, h, m, ap] = t.match(/(\d+):(\d\d) ([AP]M)/)!;
    return ((Number(h) % 12) + (ap === 'PM' ? 12 : 0)) * 60 + Number(m);
  };
  expect(toMinutes(end) - toMinutes(start)).toBe(60);
});

test('a topic changed again while its times load has the last word', async ({ page }) => {
  test.skip(!wide());
  await page.route(/\/$/, async (route) => {
    const res = await route.fetch();
    const html = (await res.text()).replace(/(data-boot[^>]*>)([\s\S]*?)(<\/script>)/, (_, open: string, json: string, close: string) => {
      const boot = JSON.parse(json);
      boot.routes.find((r: { id: string }) => r.id === 'speaking').minutes = 60;
      return open + JSON.stringify(boot) + close;
    });
    await route.fulfill({ response: res, body: html });
  });
  await page.route('**/api/slots?route=speaking', async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.fallback();
  });
  await page.goto('/');
  await expect(page.locator('.slot-time').first()).toBeVisible();
  await page.locator('[data-topic="speaking"]').click();
  await page.locator('[data-topic="speaking"]').click();
  await expect(page.locator('[data-live]')).toHaveText('Topic cleared. Showing 30-minute times.');
  await page.waitForTimeout(1200);
  await expect(page.locator('[data-live]')).toHaveText('Topic cleared. Showing 30-minute times.');
  await expect(page.locator('[data-topic][aria-pressed="true"]')).toHaveCount(0);
});

test('validation explains what to fix', async ({ page }) => {
  await page.goto('/');
  await pickFirstTime(page);
  await page.getByRole('button', { name: 'Book this time' }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter your name.');
  await page.locator('#f-name').fill('Someone');
  await page.locator('#f-email').fill('nope');
  await page.getByRole('button', { name: 'Book this time' }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter a valid email address.');
});

test('dark theme', async ({ browser }, info) => {
  const context = await browser.newContext({ ...info.project.use, colorScheme: 'dark' });
  const page = await context.newPage();
  await page.goto('/ai-answers');
  if (!wide()) await page.locator('[data-day]').first().click();
  await expect(page.locator('.slot-time').first()).toBeVisible();
  await page.waitForTimeout(700);
  await shot(page, '06-dark-calendar');
  await context.close();
});

test('without JavaScript, every topic and a way to get in touch are still there', async ({ browser }, info) => {
  const context = await browser.newContext({ ...info.project.use, javaScriptEnabled: false });
  const page = await context.newPage();
  for (const path of ['/', '/speaking']) {
    await page.goto(path);
    // getByText skips <noscript> content by design, so match the elements.
    const topics = page.locator('.rail-static');
    await expect(topics.locator('p', { hasText: 'For people past the demo stage.' })).toBeVisible();
    await expect(topics.locator('p', { hasText: 'Conference talks, podcasts, panels' })).toBeVisible();
    await expect(page.locator('p', { hasText: 'Picking a time needs JavaScript.' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'pkonopl@gmail.com' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'LinkedIn' })).toBeVisible();
    // Nothing that looks like a control and does nothing.
    await expect(page.locator('[data-topic]').filter({ visible: true })).toHaveCount(0);
    await expect(page.locator('[data-pane="time"]')).toBeHidden();
  }
  await shot(page, '07-no-js');
  await context.close();
});

test('changing the timezone relabels the times without changing the instants', async ({ page }) => {
  await page.goto('/');
  if (!wide()) await page.locator('[data-day]').first().click();
  const before = await page.locator('.slot-time').first().textContent();
  await page.locator('[data-tz]').selectOption('America/Los_Angeles');
  if (!wide()) await page.locator('[data-day]').first().click();
  const after = await page.locator('.slot-time').first().textContent();
  expect(after).not.toBe(before);
});
