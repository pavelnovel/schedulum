import type { APIRoute } from 'astro';
import { coordinator, failure } from '../../lib/http';

export const prerender = false;

export const GET: APIRoute = async ({ locals, request }) => {
  try {
    return await coordinator(locals.env).fetch(request);
  } catch (err) {
    return failure(err);
  }
};
