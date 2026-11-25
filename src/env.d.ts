/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Cloudflare Turnstile site key, public by design. */
  readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
}

declare namespace App {
  interface Locals {
    env: import('./lib/env').Env;
  }
}

declare module 'cloudflare:workers' {
  export const env: import('./lib/env').Env;
}
