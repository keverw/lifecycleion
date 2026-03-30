import qs from 'qs';

/**
 * Bun.serve-based test server for http-client integration tests.
 *
 * Usage:
 *   const server = await startTestServer();
 *   // server.url — base URL e.g. 'http://localhost:PORT'
 *   await server.stop();
 */

export interface TestServer {
  url: string;
  stop: () => Promise<void>;
}

// Per-request flaky counter — keyed by client IP / request path
const flakyCounts = new Map<string, number>();

export function startTestServer(): TestServer {
  const handleRequest = async (req: Request) => {
    const url = new URL(req.url);
    const path = url.pathname;

    // GET /api/test — echo request headers
    if (path === '/api/test' && req.method === 'GET') {
      const headers: Record<string, string> = {};

      for (const [key, value] of req.headers.entries()) {
        headers[key] = value;
      }

      return Response.json({ headers });
    } else if (path.startsWith('/api/users/') && req.method === 'GET') {
      // GET /api/users/:id
      const id = path.slice('/api/users/'.length);
      return Response.json({ id, name: `User ${id}` });
    } else if (path === '/api/users' && req.method === 'POST') {
      // POST /api/users
      let body: unknown = null;

      try {
        body = await req.json();
      } catch {
        // non-json body
      }

      return Response.json({ created: true, data: body }, { status: 201 });
    } else if (path === '/api/error' && req.method === 'GET') {
      // GET /api/error — 500
      return Response.json({ error: 'internal server error' }, { status: 500 });
    } else if (path === '/api/bad-request' && req.method === 'GET') {
      // GET /api/bad-request — 400
      return Response.json({ error: 'bad request' }, { status: 400 });
    } else if (path === '/api/slow' && req.method === 'GET') {
      // GET /api/slow — 500ms delay
      await new Promise((resolve) => setTimeout(resolve, 500));
      return Response.json({ slow: true });
    } else if (path === '/api/text' && req.method === 'GET') {
      // GET /api/text — plain text
      return new Response('hello world', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    } else if (path === '/api/set-cookie' && req.method === 'GET') {
      // GET /api/set-cookie
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'session=abc123; Path=/; HttpOnly',
        },
      });
    } else if (path === '/api/set-cookies' && req.method === 'GET') {
      // GET /api/set-cookies
      const headers = new Headers({
        'content-type': 'application/json',
      });
      headers.append('set-cookie', 'session=abc123; Path=/; HttpOnly');
      headers.append('set-cookie', 'theme=dark; Path=/');

      return new Response(JSON.stringify({ ok: true }), { headers });
    } else if (path === '/api/echo-cookies' && req.method === 'GET') {
      // GET /api/echo-cookies
      const cookieHeader = req.headers.get('cookie') ?? '';
      return Response.json({ cookies: cookieHeader });
    } else if (path === '/api/query' && req.method === 'GET') {
      // GET /api/query — echo query params, preserving qs-style arrays/nesting
      const params = qs.parse(url.searchParams.toString());
      return Response.json({ params });
    } else if (path === '/api/upload' && req.method === 'POST') {
      // POST /api/upload — accept FormData
      const fields: Record<string, string> = {};

      try {
        const form = await req.formData();

        for (const [key, value] of form.entries()) {
          if (typeof value === 'string') {
            fields[key] = value;
          } else {
            fields[key] = `[File: ${(value as File).name}]`;
          }
        }
      } catch {
        // Not form-data
      }

      return Response.json({ received: true, fields });
    } else if (path === '/api/flaky' && req.method === 'GET') {
      // GET /api/flaky — 503 for first 2 calls, then 200
      const key = 'flaky';
      const count = (flakyCounts.get(key) ?? 0) + 1;
      flakyCounts.set(key, count);

      if (count <= 2) {
        return Response.json(
          { attempt: count, error: 'service unavailable' },
          { status: 503 },
        );
      }

      return Response.json({ attempt: count, ok: true });
    } else if (path === '/api/reset-flaky' && req.method === 'POST') {
      // POST /api/reset-flaky — reset flaky counter
      flakyCounts.clear();
      return Response.json({ reset: true });
    } else if (path === '/api/flaky-redirect' && req.method === 'GET') {
      // GET /api/flaky-redirect — 503 for first 2 calls, then 302 redirect to /api/test
      const key = 'flaky-redirect';
      const count = (flakyCounts.get(key) ?? 0) + 1;
      flakyCounts.set(key, count);

      if (count <= 2) {
        return Response.json(
          { attempt: count, error: 'service unavailable' },
          { status: 503 },
        );
      }

      return new Response(null, {
        status: 302,
        headers: { location: `${new URL(req.url).origin}/api/test` },
      });
    } else if (
      path === '/api/redirect/301-flaky-target' &&
      req.method === 'GET'
    ) {
      // GET /api/redirect/301-flaky-target — redirects to /api/flaky-target
      // The target returns 503 once, then 200 on retry.
      return new Response(null, {
        status: 301,
        headers: {
          location: `${new URL(req.url).origin}/api/flaky-target`,
        },
      });
    } else if (path === '/api/flaky-target' && req.method === 'GET') {
      // GET /api/flaky-target — 503 on first call, then 200 on second
      const key = 'flaky-target';
      const count = (flakyCounts.get(key) ?? 0) + 1;
      flakyCounts.set(key, count);

      if (count <= 1) {
        return Response.json(
          { attempt: count, error: 'service unavailable' },
          { status: 503 },
        );
      }

      return Response.json({ ok: true, attempt: count });
    } else if (path === '/api/redirect/301' && req.method === 'GET') {
      // GET /api/redirect/301 — redirects to /api/test
      return new Response(null, {
        status: 301,
        headers: { location: `${new URL(req.url).origin}/api/test` },
      });
    } else if (path === '/api/redirect/302-post' && req.method === 'POST') {
      // POST /api/redirect/302-post — redirect a POST to a GET target
      return new Response(null, {
        status: 302,
        headers: {
          location: `${new URL(req.url).origin}/api/redirect/echo-method`,
        },
      });
    } else if (path === '/api/redirect/302-slow' && req.method === 'GET') {
      // GET /api/redirect/302-slow — redirect to a slow GET target
      return new Response(null, {
        status: 302,
        headers: {
          location: `${new URL(req.url).origin}/api/slow`,
        },
      });
    } else if (path === '/api/redirect/loop-a' && req.method === 'GET') {
      // GET /api/redirect/loop-a — redirect into a loop
      return new Response(null, {
        status: 302,
        headers: {
          location: `${new URL(req.url).origin}/api/redirect/loop-b`,
        },
      });
    } else if (path === '/api/redirect/loop-b' && req.method === 'GET') {
      // GET /api/redirect/loop-b — redirect back into the loop
      return new Response(null, {
        status: 302,
        headers: {
          location: `${new URL(req.url).origin}/api/redirect/loop-a`,
        },
      });
    } else if (path === '/api/redirect/echo-method') {
      // GET /api/redirect/echo-method — echo the method/body seen after redirect
      const text = await req.text();
      return Response.json({ method: req.method, body: text });
    } else if (path === '/api/no-content' && req.method === 'GET') {
      // GET /api/no-content — 204
      return new Response(null, { status: 204 });
    } else if (path === '/api/update' && req.method === 'PUT') {
      // PUT /api/update — echo body
      let body: unknown = null;

      try {
        body = await req.json();
      } catch {
        body = await req.text();
      }

      return Response.json({ updated: true, data: body });
    } else if (path === '/api/patch' && req.method === 'PATCH') {
      // PATCH /api/patch — echo body
      let body: unknown = null;

      try {
        body = await req.json();
      } catch {
        body = await req.text();
      }

      return Response.json({ patched: true, data: body });
    } else if (path.startsWith('/api/users/') && req.method === 'DELETE') {
      // DELETE /api/users/:id
      const id = path.slice('/api/users/'.length);
      return Response.json({ deleted: true, id });
    } else if (path === '/api/head' && req.method === 'HEAD') {
      // HEAD /api/test
      return new Response(null, {
        status: 200,
        headers: { 'x-head-ok': 'true' },
      });
    } else {
      return Response.json({ error: 'not found' }, { status: 404 });
    }
  };

  const server = Bun.serve({
    port: 0,
    fetch: handleRequest,
  });

  return {
    url: `http://localhost:${server.port}`,
    stop: async () => {
      await server.stop();
    },
  };
}
