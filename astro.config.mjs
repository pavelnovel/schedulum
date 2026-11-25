import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwind from 'tailwindcss';
import autoprefixer from 'autoprefixer';

let demoBuild = false;

// Pages are static by default; the API routes and the manage page opt out
// with `export const prerender = false` and run in the Cloudflare Worker.
export default defineConfig({
  site: 'https://meet.pavelnovel.com',
  output: 'static',
  session: false,
  // `/speaking`, not `/speaking/`: built as speaking.html, which Workers
  // assets serve at the bare path. Directory output would redirect every topic link.
  build: { format: 'file' },
  trailingSlash: 'never',
  // A topic that was removed after its link went out.
  redirects: { '/something-else': '/' },
  adapter: cloudflare({
    imageService: 'passthrough',
  }),
  vite: {
    css: { postcss: { plugins: [tailwind(), autoprefixer()] } },
    plugins: [{
      name: 'schedulum-worker-output',
      configResolved(config) {
        demoBuild = config.mode === 'demo';
      },
      generateBundle: {
        order: 'post',
        handler(_options, bundle) {
          // The Cloudflare plugin emits a plaintext copy for preview. Wrangler
          // reads the original private file directly in our preview command.
          delete bundle['.dev.vars'];

          // Wrangler otherwise rewrites local request URLs to the deployed domain,
          // including the manage links returned to people trying the demo.
          const manifest = bundle['wrangler.json'];
          if (demoBuild && manifest?.type === 'asset') {
            const config = JSON.parse(manifest.source.toString());
            delete config.route;
            delete config.routes;
            manifest.source = JSON.stringify(config);
          }
        },
      },
    }],
  },
  devToolbar: { enabled: false },
});
