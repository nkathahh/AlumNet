/*
 * AlumNet gateway (Cloudflare Pages Functions).
 *
 * Cloudflare Pages serves the pages, styles and scripts in frontend/public.
 * Requests for /api, /media, /brand and /health are passed on by this
 * function to the AlumNet server on Hugging Face (BACKEND_URL), so the
 * browser only ever talks to one HTTPS address and sign-in cookies stay on
 * it. _routes.json limits this function to those paths; everything else is
 * a plain static file.
 *
 * What the gateway adds:
 * - the shared GATEWAY_SECRET, which the server checks, so the server cannot
 *   be used directly, skipping the gateway;
 * - the visitor's real address, for the server's rate limits;
 * - a size limit, and a clear message when the server is asleep or down.
 * Sign-in, permissions and validation stay on the server.
 *
 * Settings (Cloudflare Pages > Settings > Variables and secrets):
 *   BACKEND_URL     https://<username>-alumnet-api.hf.space
 *   GATEWAY_SECRET  the same long random value as the server's GATEWAY_SECRET (encrypt it)
 */
const PROXIED = /^\/(api|media|brand)\/|^\/health$/;
const MAX_BODY = 6 * 1024 * 1024; // images are up to 5 MB
const DROP = ['host', 'accept-encoding', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'x-client-ip', 'x-alumnet-gateway'];

function problem(status, error) {
  return new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });
}

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  if (!PROXIED.test(url.pathname)) return next();
  if (!env.BACKEND_URL || !env.GATEWAY_SECRET) return problem(503, 'AlumNet is not fully set up yet. Please try again later.');
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return problem(413, 'That is too much data to send at once.');

  const headers = new Headers(request.headers);
  DROP.forEach((h) => headers.delete(h));
  headers.set('x-alumnet-gateway', env.GATEWAY_SECRET);
  headers.set('x-client-ip', request.headers.get('cf-connecting-ip') || '');
  headers.set('x-forwarded-proto', 'https');

  // Read in full (at most 6 MB), so the limit holds even without a content-length
  let body;
  if (!['GET', 'HEAD'].includes(request.method)) {
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY) return problem(413, 'That is too much data to send at once.');
  }

  const target = new URL(url.pathname + url.search, env.BACKEND_URL);
  let res;
  try {
    res = await fetch(target, { method: request.method, headers, body, redirect: 'manual' });
  } catch {
    return problem(502, 'The AlumNet server could not be reached. If it has been asleep it takes about a minute to wake up: try again shortly.');
  }
  // A sleeping or rebuilding Space answers with an HTML page; give the app JSON it can show
  const type = res.headers.get('content-type') || '';
  if (res.status >= 500 && url.pathname.startsWith('/api/') && !type.includes('application/json')) {
    return problem(503, 'The AlumNet server is starting up. Please try again in a minute.');
  }
  return new Response(res.body, res);
}
