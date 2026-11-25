import { BookingCoordinator } from '../src/lib/coordinator';
import type { Env } from '../src/lib/env';

export function testLocals(bindings: Record<string, unknown>) {
  const env = { ...bindings, BOOKING_COORDINATOR: { getByName: () => instance } } as Env;
  const instance = new BookingCoordinator(undefined, env);
  return { env };
}
