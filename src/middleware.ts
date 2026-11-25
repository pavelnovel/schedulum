import { env } from 'cloudflare:workers';
import { defineMiddleware } from 'astro:middleware';

export const onRequest = defineMiddleware(({ locals }, next) => {
  locals.env = env;
  return next();
});
