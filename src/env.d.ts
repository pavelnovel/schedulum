/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Cloudflare Turnstile site key, public by design. */
  readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
}

type Runtime = import('@astrojs/cloudflare').Runtime<import('./lib/env').Env>;

declare namespace App {
  interface Locals extends Runtime {}
}
