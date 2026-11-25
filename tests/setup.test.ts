import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeVars } from '../scripts/connect-google.mjs';
import { syncOrigin } from '../scripts/push-busy.mjs';

describe('local Google connection', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'schedulum-setup-'));
    file = join(dir, '.dev.vars');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each([false, true])('saves first-time credentials privately in demo mode (existing file: %s)', (existing) => {
    if (existing) writeFileSync(file, 'OTHER=keep\n', { mode: 0o644 });
    writeVars({ GOOGLE_REFRESH_TOKEN: 'test-value' }, file);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('CALENDAR_MODE=fake\n');
    expect(text).toContain('PUBLIC_URL=http://localhost:4321');
    expect(text).toContain('GOOGLE_REFRESH_TOKEN=test-value');
    if (existing) expect(text).toContain('OTHER=keep');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('preserves an explicit real calendar, local origin, and signing secret on reconnect', () => {
    writeFileSync(file, 'CALENDAR_MODE=google\nPUBLIC_URL=http://localhost:8787\nSIGNING_SECRET=existing\n');
    writeVars({ GOOGLE_REFRESH_TOKEN: 'replacement' }, file);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('CALENDAR_MODE=google\n');
    expect(text).toContain('PUBLIC_URL=http://localhost:8787\n');
    expect(text).toContain('SIGNING_SECRET=existing\n');
  });
});

describe('calendar sync destination', () => {
  it('requires the operator to choose the receiving site', () => {
    expect(() => syncOrigin(undefined)).toThrow('Set SCHEDULUM_URL');
    expect(syncOrigin('https://booking.example/')).toBe('https://booking.example');
  });
  it.each(['http://booking.example', 'https://user@booking.example', 'https://booking.example/path'])(
    'rejects %s', (value) => expect(() => syncOrigin(value)).toThrow('HTTPS origin')
  );
});
