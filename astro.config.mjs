import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwind from '@astrojs/tailwind';

// Pages are static by default; the API routes and the manage page opt out
// with `export const prerender = false` and run in the Cloudflare Worker.
export default defineConfig({
  site: 'https://meet.pavelnovel.com',
  output: 'static',
  // `/speaking`, not `/speaking/`: built as speaking.html, which Workers
  // assets serve at the bare path. Directory output would redirect every topic link.
  build: { format: 'file' },
  trailingSlash: 'never',
  // A topic that was removed after its link went out.
  redirects: { '/something-else': '/' },
  adapter: cloudflare({
    imageService: 'passthrough',
    platformProxy: { enabled: true },
  }),
  integrations: [tailwind({ applyBaseStyles: false })],
  devToolbar: { enabled: false },
});
