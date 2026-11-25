import { expect, test } from '@playwright/test';

test('concurrent reschedules across booking routes preserve the losing appointment', async ({ request }) => {
  const open = async (): Promise<string[]> => {
    const res = await request.get('/api/slots');
    expect(res.ok()).toBe(true);
    return (await res.json()).slots;
  };
  const appointments: { token: string; original: string }[] = [];

  try {
    const secondRoute = test.info().project.metadata.advertising ? 'spoiled-nyc' : 'ai-systems';
    for (const routeId of ['speaking', secondRoute]) {
      const [original] = await open();
      const response = await request.post('/api/book', {
        data: { routeId, start: original, name: 'Local test', email: `move-${crypto.randomUUID()}@example.com` },
      });
      expect(response.ok()).toBe(true);
      const { booking } = await response.json();
      appointments.push({ token: new URL(booking.manageUrl).pathname.split('/').pop()!, original });
    }

    const [destination] = await open();
    const moves = await Promise.all(appointments.map(({ token }) =>
      request.post('/api/manage', { data: { action: 'reschedule', token, start: destination } })
    ));
    expect(moves.map(r => r.status()).sort()).toEqual([200, 409]);
    const loser = appointments[moves.findIndex(r => r.status() === 409)];
    expect(await open()).not.toContain(loser.original);
    expect(await open()).not.toContain(destination);
    // Its private link can still move the original appointment after the conflict.
    const retry = await request.post('/api/manage', {
      data: { action: 'reschedule', token: loser.token, start: (await open())[0] },
    });
    expect(retry.ok()).toBe(true);
  } finally {
    for (const { token } of appointments) {
      expect((await request.post('/api/manage', { data: { action: 'cancel', token } })).ok()).toBe(true);
    }
  }
});
