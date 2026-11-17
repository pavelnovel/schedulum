import { describe, expect, it } from 'vitest';
import { mailbox } from '../src/lib/tokens';

describe('mailbox', () => {
  it('drops + tags and case', () => {
    expect(mailbox(' Ada+Talks@Example.com ')).toBe('ada@example.com');
  });

  it('ignores dots and googlemail.com for Gmail only', () => {
    expect(mailbox('a.d.a@googlemail.com')).toBe('ada@gmail.com');
    expect(mailbox('a.d.a@example.com')).toBe('a.d.a@example.com');
  });

  it('keeps an address that would normalize to nothing', () => {
    expect(mailbox('+foo@gmail.com')).toBe('+foo@gmail.com');
    expect(mailbox('.@gmail.com')).toBe('.@gmail.com');
    expect(mailbox('+foo@gmail.com')).not.toBe(mailbox('+bar@gmail.com'));
  });
});
