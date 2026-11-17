import { describe, expect, it } from 'vitest';
import { clockLabel, fit, fitText, genericName, offsetLabel, zoneLabel, zoneName, type FitInput } from '../src/lib/fit';
import { visitorFrom } from '../src/lib/http';

describe('visitorFrom', () => {
  it('passes on Cloudflare’s zone and nothing about place', () => {
    expect(visitorFrom({ timezone: 'Europe/Berlin', city: 'Frankfurt', country: 'DE', latitude: '50.1' })).toEqual({ timeZone: 'Europe/Berlin' });
  });

  it('passes on nothing it can’t trust', () => {
    expect(visitorFrom(undefined)).toEqual({});
    expect(visitorFrom({ timezone: 'Mars/Olympus' })).toEqual({});
    expect(visitorFrom({ timezone: '<script>' })).toEqual({});
    expect(visitorFrom({ timezone: 42 })).toEqual({});
  });
});

const now = new Date('2026-10-26T12:00:00Z'); // a Monday; New York on EDT until November 1
const hours = { from: 9, to: 19 };

function say(over: Partial<FitInput>) {
  const input: FitInput = {
    zone: 'America/New_York',
    source: 'device',
    deviceZone: 'America/New_York',
    visitor: null,
    hours,
    allHours: false,
    counts: { inside: 10, outside: 0 },
    canNote: true,
    now,
    locale: 'en-US',
    ...over,
  };
  const f = fit(input);
  return { f, text: fitText(f, input.zone, now, 'en-US') };
}

describe('labels', () => {
  it('formats offsets the way the zone picker shows them', () => {
    expect(offsetLabel('Asia/Tokyo', now)).toBe('GMT+9');
    expect(offsetLabel('Asia/Kolkata', now)).toBe('GMT+5:30');
    expect(offsetLabel('America/New_York', now)).toBe('GMT-4');
    expect(offsetLabel('UTC', now)).toBe('GMT+0');
  });

  it('names a zone without a place, falling back to the offset', () => {
    expect(zoneName('America/New_York', now, 'en-US')).toBe('Eastern Time');
    expect(zoneName('Europe/Berlin', now, 'en-US')).toBe('Central European Time');
    expect(zoneName('Asia/Tokyo', now, 'en-US')).toBe('Japan Standard Time');
    expect(zoneName('UTC', now, 'en-US')).toBe('GMT+0');
    expect(genericName('America/Los_Angeles', now, 'en-US')).toBe('Pacific Time');
  });

  it('keeps cities for the full list, with current names for zones browsers report by old ones', () => {
    expect(zoneLabel('Asia/Tokyo', now)).toBe('Tokyo (GMT+9)');
    expect(zoneLabel('Asia/Calcutta', now)).toBe('Kolkata (GMT+5:30)');
    expect(zoneLabel('Europe/Kiev', now)).toBe('Kyiv (GMT+2)');
  });

  it('writes clock times in the visitor’s style', () => {
    expect(clockLabel(9, 0, 'en-US')).toBe('9 AM');
    expect(clockLabel(19, 0, 'en-US')).toBe('7 PM');
    expect(clockLabel(9, 30, 'en-US')).toBe('9:30 AM');
    expect(clockLabel(19, 0, 'en-GB')).toBe('19:00');
  });
});

describe('the notice, from the device zone', () => {
  it('says only which zone when every time already fits', () => {
    const { f, text } = say({});
    expect(text).toBe('Times are in your time zone, Eastern Time.');
    expect(f.toggle).toBeUndefined();
    expect(f.fullSchedule).toBe(false);
  });

  it('names the hours and offers every time when some are hidden', () => {
    const { f, text } = say({ zone: 'Europe/London', deviceZone: 'Europe/London', counts: { inside: 8, outside: 4 } });
    expect(text).toBe('You seem to be on UK Time, so I’m showing times from 9 AM to 7 PM.');
    expect(f.toggle).toEqual({ label: 'Show all times', showAll: true });
  });

  it('shows the full schedule when nothing fits, says so, and offers a note', () => {
    const { f, text } = say({ zone: 'Asia/Tokyo', deviceZone: 'Asia/Tokyo', counts: { inside: 0, outside: 40 } });
    expect(text).toBe(
      'You seem to be on Japan Standard Time. None of my open times fall between 9 AM and 7 PM for you, ' +
        'so here’s my full schedule. I know these are outside your working hours. ' +
        'If none of them work, send me a note and we’ll find a time.'
    );
    expect(f.fullSchedule).toBe(true);
    expect(f.toggle).toBeUndefined();
  });

  it('leaves out the note where the page can’t take one', () => {
    const { text } = say({ zone: 'Asia/Tokyo', deviceZone: 'Asia/Tokyo', counts: { inside: 0, outside: 40 }, canNote: false });
    expect(text).toMatch(/I know these are outside your working hours\.$/);
  });

  it('offers the filter back once every time is showing', () => {
    const { f, text } = say({ zone: 'Europe/London', deviceZone: 'Europe/London', allHours: true, counts: { inside: 3, outside: 4 } });
    expect(text).toBe('Showing every time I have, in UK Time.');
    expect(f.toggle).toEqual({ label: 'Show only 9 AM to 7 PM', showAll: false });
  });

  it('says so when a booking being moved was outside the visitor’s hours', () => {
    const { text } = say({ zone: 'Europe/London', deviceZone: 'Europe/London', allHours: true, bookedOutside: true, counts: { inside: 3, outside: 4 } });
    expect(text).toBe('You booked outside 9 AM to 7 PM, so I’m showing every time I have, in UK Time.');
  });

  it('keeps it short while the times load', () => {
    expect(say({ counts: null }).text).toBe('Times are in your time zone, Eastern Time.');
  });
});

describe('the notice, once the visitor picks a zone', () => {
  it('drops the guesswork', () => {
    expect(say({ zone: 'Pacific/Auckland', source: 'chosen', deviceZone: 'Asia/Tokyo', counts: { inside: 3, outside: 9 } }).text).toBe(
      'Showing times from 9 AM to 7 PM in New Zealand Time.'
    );
    const none = say({ zone: 'Asia/Tokyo', source: 'chosen', deviceZone: 'Europe/London', counts: { inside: 0, outside: 9 } });
    expect(none.text).toMatch(/^None of my open times fall between 9 AM and 7 PM in Japan Standard Time, so here’s my full schedule\./);
    expect(none.f.fullSchedule).toBe(true);
  });

  it('never suggests the connection’s zone after a pick', () => {
    const { f } = say({ zone: 'Pacific/Auckland', source: 'chosen', deviceZone: 'Asia/Tokyo', visitor: { timeZone: 'Europe/Berlin' } });
    expect(f.correction).toBeUndefined();
  });
});

describe('the notice, with Cloudflare’s guess at the zone', () => {
  it('says nothing about the connection when it keeps the device’s clock', () => {
    const { text, f } = say({ visitor: { timeZone: 'America/Toronto' } });
    expect(text).toBe('Times are in your time zone, Eastern Time.');
    expect(f.correction).toBeUndefined();
  });

  it('treats zone aliases with the same clock as agreeing', () => {
    expect(say({ zone: 'Asia/Kolkata', deviceZone: 'Asia/Kolkata', visitor: { timeZone: 'Asia/Calcutta' } }).f.correction).toBeUndefined();
  });

  it('keeps to the device zone on a VPN, and offers the other zone by name', () => {
    const { text, f } = say({ zone: 'Asia/Tokyo', deviceZone: 'Asia/Tokyo', counts: { inside: 0, outside: 9 }, visitor: { timeZone: 'Europe/Berlin' } });
    expect(text).toMatch(/^You seem to be on Japan Standard Time/);
    expect(f.correction).toEqual({ zone: 'Europe/Berlin', label: 'Central European Time' });
  });

  it('offers the connection’s zone to a device left on UTC', () => {
    const { text, f } = say({ zone: 'UTC', deviceZone: 'UTC', visitor: { timeZone: 'Europe/Berlin' } });
    expect(text).toBe('Times are in your time zone, GMT+0.');
    expect(f.correction?.zone).toBe('Europe/Berlin');
  });

  it('goes by the connection when the device gives no zone', () => {
    const { text } = say({ zone: 'Europe/Berlin', source: 'ip', deviceZone: null, counts: { inside: 5, outside: 3 }, visitor: { timeZone: 'Europe/Berlin' } });
    expect(text).toBe(
      'I couldn’t read your device’s time zone, so I’m going by your connection. Showing times from 9 AM to 7 PM in Central European Time.'
    );
  });

  it('falls back to the host’s zone with neither', () => {
    const { text, f } = say({ source: 'host', deviceZone: null, counts: { inside: 0, outside: 9 } });
    expect(text).toBe('I couldn’t tell your time zone, so these times are in mine. Pick yours: Eastern Time');
    expect(f.toggle).toBeUndefined();
    expect(f.fullSchedule).toBe(false);
  });

  it('never names a place', () => {
    const states: Partial<FitInput>[] = [
      { zone: 'Europe/London', deviceZone: 'Europe/London', counts: { inside: 2, outside: 3 } },
      { zone: 'Asia/Tokyo', deviceZone: 'Asia/Tokyo', counts: { inside: 0, outside: 3 }, visitor: { timeZone: 'Europe/Berlin' } },
      { zone: 'America/New_York', visitor: { timeZone: 'America/New_York' } },
    ];
    for (const s of states) {
      const { f, text } = say(s);
      expect(`${text} ${f.correction?.label ?? ''}`).not.toMatch(/London|Tokyo|New York|Berlin/);
    }
  });

  it('keeps exactly one place for the zone picker in every state', () => {
    const states: Partial<FitInput>[] = [
      {},
      { counts: null },
      { counts: { inside: 0, outside: 3 } },
      { counts: { inside: 2, outside: 3 } },
      { counts: { inside: 2, outside: 3 }, allHours: true },
      { source: 'chosen', counts: { inside: 0, outside: 3 } },
      { source: 'ip', visitor: { timeZone: 'America/New_York' }, counts: { inside: 0, outside: 3 } },
      { source: 'host' },
    ];
    for (const s of states) expect(say(s).f.text.filter((p) => typeof p !== 'string')).toHaveLength(1);
  });
});
