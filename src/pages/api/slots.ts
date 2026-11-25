import type { APIRoute } from 'astro';
import { coordinator, failure, requireEnabledRoute } from '../../lib/http';

export const prerender = false;

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    requireEnabledRoute(locals.env, new URL(request.url).searchParams.get('route'));
    return await coordinator(locals.env).fetch(request);
  } catch (err) {
    return failure(err);
  }
};
