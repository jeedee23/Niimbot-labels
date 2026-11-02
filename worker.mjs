import drawers from './drawers.json' with { type: 'json' };

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/drawers' && request.method === 'GET') {
      return json({ drawers, readOnly: true });
    }
    if (/^\/api\/drawers\/\d{3}$/.test(url.pathname) && request.method === 'PATCH') {
      return json({ error: 'Hosted saving is not configured yet. This deployment is read-only; use the local editor to save edits.' }, 503);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'API route or method not found.' }, 404);
    return env.ASSETS.fetch(request);
  }
};
