/**
 * Cloudflare Turnstile on the details form and the note form. It runs while
 * the visitor types, and most people never see it; it asks for a click only
 * when it isn't sure. Each token is good for one attempt.
 */
type TurnstileApi = {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(widgetId: string): void;
};

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const WAIT_MS = 15_000;

export function humanCheck(siteKey: string, el: HTMLElement, onInteractive: () => void, action = 'book') {
  let token = '';
  let widget: string | undefined;
  let loading: Promise<TurnstileApi> | undefined;
  const waiting: ((t: string) => void)[] = [];

  const api = () =>
    (loading ??= new Promise<TurnstileApi>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SCRIPT;
      s.async = true;
      s.onload = () => {
        const t = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
        t ? resolve(t) : reject(new Error('Turnstile did not load'));
      };
      s.onerror = () => reject(new Error('Turnstile did not load'));
      document.head.appendChild(s);
    }).catch((err) => {
      // Let the next attempt try again; the network may have come back.
      loading = undefined;
      throw err;
    }));

  const wake = (t: string) => {
    for (const resolve of waiting.splice(0)) resolve(t);
  };
  const settle = (t: string) => {
    token = t;
    if (t) wake(t);
  };
  // An error wakes anyone waiting with nothing, so the visitor hears about it
  // now instead of after the full wait.
  const fail = () => {
    token = '';
    wake('');
  };

  async function start() {
    if (widget !== undefined) return;
    const turnstile = await api();
    widget ??= turnstile.render(el, {
      sitekey: siteKey,
      action,
      appearance: 'interaction-only',
      size: 'flexible',
      theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
      // Turnstile passes more than the token; take only the token.
      callback: (t: string) => settle(t),
      'expired-callback': () => settle(''),
      'error-callback': fail,
      'before-interactive-callback': onInteractive,
    });
  }

  return {
    /** Begins the check in the background. Safe to call repeatedly. */
    start() {
      start().catch(() => {});
    },
    /** The current token, waiting for the check to finish. Empty if it fails or never does. */
    async token(): Promise<string> {
      try {
        await start();
      } catch {
        return '';
      }
      if (token) return token;
      return new Promise((resolve) => {
        waiting.push(resolve);
        setTimeout(() => resolve(token), WAIT_MS);
      });
    },
    /** Spends the current token and starts on the next one. */
    reset() {
      token = '';
      if (widget !== undefined) api().then((t) => t.reset(widget!));
    },
  };
}
