import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function scan(page: Page, where: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  const summary = violations.map((v) => `${where}: ${v.id} (${v.impact}) — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(summary, summary.join('\n')).toEqual([]);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`every step passes axe (${colorScheme})`, async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop');
    const context = await browser.newContext({ ...info.project.use, colorScheme, reducedMotion: 'reduce' });
    const page = await context.newPage();

    await page.goto('/');
    await expect(page.locator('[data-cal-note]')).not.toHaveText(/Checking/);
    await expect(page.locator('.slot-time').first()).toBeVisible();
    await scan(page, 'landing');

    await page.locator('[data-topic="managing-agents"]').click();
    await scan(page, 'landing with a topic');

    await page.locator('.slot-time').first().click();
    await scan(page, 'details');

    await page.locator('#f-name').fill('Axe Tester');
    await page.locator('#f-email').fill(`axe-${Date.now()}-${colorScheme}@example.com`);
    await page.getByRole('button', { name: 'Book this time' }).click();
    await expect(page.getByRole('heading', { name: 'You’re booked.' })).toBeVisible();
    await scan(page, 'done');

    // Follow the link's path on the server under test; PUBLIC_URL may name another origin.
    const manage = new URL((await page.getByRole('link', { name: 'Reschedule or cancel' }).getAttribute('href'))!).pathname;
    await page.goto(manage!);
    await scan(page, 'manage');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel conversation' }).click();
    await expect(page.getByRole('heading', { name: 'Cancelled' })).toBeVisible();
    await scan(page, 'cancelled');

    await page.goto('/privacy');
    await expect(page.getByText('Cloudflare’s rough guess at your time zone')).toBeVisible();
    await scan(page, 'privacy');

    await context.close();
  });

  test(`the phone form, with its topic choice, passes axe (${colorScheme})`, async ({ browser }, info) => {
    test.skip(info.project.name !== 'mobile');
    const context = await browser.newContext({ ...info.project.use, colorScheme, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto('/');
    await page.locator('[data-day]').first().click();
    await page.locator('.slot-time').first().click();
    await scan(page, 'phone details');
    await page.locator('[data-topic-select]').selectOption('ai-answers');
    await scan(page, 'phone details with a topic');
    await context.close();
  });

  test(`the hours notice and the note pass axe in every state (${colorScheme})`, async ({ browser }, info) => {
    test.skip(info.project.name !== 'desktop');
    const open = async (timezoneId: string) => {
      const context = await browser.newContext({ ...info.project.use, colorScheme, reducedMotion: 'reduce', timezoneId });
      const page = await context.newPage();
      await page.route('**/api/slots*', async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), visitor: { timeZone: 'Europe/Berlin' } } });
      });
      await page.goto('/ai-systems');
      await expect(page.locator('[data-cal-note]')).not.toHaveText(/Checking/);
      return { context, page };
    };

    const london = await open('Europe/London');
    await scan(london.page, 'London filtered');
    await london.page.locator('[data-hours-toggle]').click();
    await scan(london.page, 'London every time');
    await london.context.close();

    const tokyo = await open('Asia/Tokyo');
    await scan(tokyo.page, 'Tokyo full schedule');
    await tokyo.page.locator('[data-fit]').getByRole('button', { name: 'Send me a note' }).click();
    await scan(tokyo.page, 'note');
    await tokyo.page.locator('#n-name').fill('Axe Tester');
    await tokyo.page.locator('#n-email').fill('axe@example.com');
    await tokyo.page.locator('#n-text').fill('Mornings, my time.');
    await tokyo.page.getByRole('button', { name: 'Send note' }).click();
    await expect(tokyo.page.locator('[data-pane="noted"]')).toBeVisible();
    await scan(tokyo.page, 'note sent');
    await tokyo.context.close();
  });
}
