import crypto from 'node:crypto';
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

    // Adds Access-Control-Allow-Origin: * to every response so browser XHR
    // tests (xhr-adapter.playwright.test.ts) can make direct requests from a
    // null-origin page without CORS rejections. No effect on non-browser tests.
    const respond = (response: Response): Response => {
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      return new Response(response.body, { status: response.status, headers });
    };

    // CORS preflight — browsers send OPTIONS before cross-origin requests with
    // custom headers (x-browser-test, x-per-request, etc.).
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods':
            'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    // GET /api/test — echo request headers
    if (path === '/api/test' && req.method === 'GET') {
      const headers: Record<string, string> = {};

      for (const [key, value] of req.headers.entries()) {
        headers[key] = value;
      }

      return respond(Response.json({ headers }));
    } else if (path.startsWith('/api/users/') && req.method === 'GET') {
      // GET /api/users/:id
      const id = path.slice('/api/users/'.length);
      return respond(Response.json({ id, name: `User ${id}` }));
    } else if (path === '/api/users' && req.method === 'POST') {
      // POST /api/users
      let body: unknown = null;

      try {
        body = await req.json();
      } catch {
        // non-json body
      }

      return respond(
        Response.json({ created: true, data: body }, { status: 201 }),
      );
    } else if (path === '/api/error' && req.method === 'GET') {
      // GET /api/error — 500
      return respond(
        Response.json({ error: 'internal server error' }, { status: 500 }),
      );
    } else if (path === '/api/bad-request' && req.method === 'GET') {
      // GET /api/bad-request — 400
      return respond(Response.json({ error: 'bad request' }, { status: 400 }));
    } else if (path === '/api/slow' && req.method === 'GET') {
      // GET /api/slow — 500ms delay
      await new Promise((resolve) => setTimeout(resolve, 500));
      return respond(Response.json({ slow: true }));
    } else if (path === '/api/text' && req.method === 'GET') {
      // GET /api/text — plain text
      return respond(
        new Response('hello world', {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      );
    } else if (path === '/api/invalid-json' && req.method === 'GET') {
      // GET /api/invalid-json — malformed JSON with a JSON content-type.
      // Used to verify HTTPClient parse-failure behavior in real adapter tests.
      return respond(
        new Response('{"broken":', {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      );
    } else if (path === '/api/set-cookie' && req.method === 'GET') {
      // GET /api/set-cookie
      return respond(
        new Response(JSON.stringify({ ok: true }), {
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'session=abc123; Path=/; HttpOnly',
          },
        }),
      );
    } else if (path === '/api/set-cookies' && req.method === 'GET') {
      // GET /api/set-cookies
      const headers = new Headers({
        'content-type': 'application/json',
      });
      headers.append('set-cookie', 'session=abc123; Path=/; HttpOnly');
      headers.append('set-cookie', 'theme=dark; Path=/');

      return respond(new Response(JSON.stringify({ ok: true }), { headers }));
    } else if (path === '/api/echo-cookies' && req.method === 'GET') {
      // GET /api/echo-cookies
      const cookieHeader = req.headers.get('cookie') ?? '';
      return respond(Response.json({ cookies: cookieHeader }));
    } else if (path === '/api/query' && req.method === 'GET') {
      // GET /api/query — echo query params, preserving qs-style arrays/nesting
      const params = qs.parse(url.searchParams.toString());
      return respond(Response.json({ params }));
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

      return respond(Response.json({ received: true, fields }));
    } else if (path === '/api/flaky' && req.method === 'GET') {
      // GET /api/flaky — 503 for first 2 calls, then 200
      const key = 'flaky';
      const count = (flakyCounts.get(key) ?? 0) + 1;
      flakyCounts.set(key, count);

      if (count <= 2) {
        return respond(
          Response.json(
            { attempt: count, error: 'service unavailable' },
            { status: 503 },
          ),
        );
      }

      return respond(Response.json({ attempt: count, ok: true }));
    } else if (path === '/api/reset-flaky' && req.method === 'POST') {
      // POST /api/reset-flaky — reset flaky counter
      flakyCounts.clear();
      return respond(Response.json({ reset: true }));
    } else if (path === '/api/flaky-redirect' && req.method === 'GET') {
      // GET /api/flaky-redirect — 503 for first 2 calls, then 302 redirect to /api/test
      const key = 'flaky-redirect';
      const count = (flakyCounts.get(key) ?? 0) + 1;
      flakyCounts.set(key, count);

      if (count <= 2) {
        return respond(
          Response.json(
            { attempt: count, error: 'service unavailable' },
            { status: 503 },
          ),
        );
      }

      return respond(
        new Response(null, {
          status: 302,
          headers: { location: `${new URL(req.url).origin}/api/test` },
        }),
      );
    } else if (
      path === '/api/redirect/301-flaky-target' &&
      req.method === 'GET'
    ) {
      // GET /api/redirect/301-flaky-target — redirects to /api/flaky-target
      // The target returns 503 once, then 200 on retry.
      return respond(
        new Response(null, {
          status: 301,
          headers: {
            location: `${new URL(req.url).origin}/api/flaky-target`,
          },
        }),
      );
    } else if (path === '/api/flaky-target' && req.method === 'GET') {
      // GET /api/flaky-target — 503 on first call, then 200 on second
      const key = 'flaky-target';
      const count = (flakyCounts.get(key) ?? 0) + 1;
      flakyCounts.set(key, count);

      if (count <= 1) {
        return respond(
          Response.json(
            { attempt: count, error: 'service unavailable' },
            { status: 503 },
          ),
        );
      }

      return respond(Response.json({ ok: true, attempt: count }));
    } else if (path === '/api/redirect/301' && req.method === 'GET') {
      // GET /api/redirect/301 — redirects to /api/test
      return respond(
        new Response(null, {
          status: 301,
          headers: { location: `${new URL(req.url).origin}/api/test` },
        }),
      );
    } else if (path === '/api/redirect/302-post' && req.method === 'POST') {
      // POST /api/redirect/302-post — redirect a POST to a GET target
      return respond(
        new Response(null, {
          status: 302,
          headers: {
            location: `${new URL(req.url).origin}/api/redirect/echo-method`,
          },
        }),
      );
    } else if (path === '/api/redirect/302-slow' && req.method === 'GET') {
      // GET /api/redirect/302-slow — redirect to a slow GET target
      return respond(
        new Response(null, {
          status: 302,
          headers: {
            location: `${new URL(req.url).origin}/api/slow`,
          },
        }),
      );
    } else if (path === '/api/redirect/loop-a' && req.method === 'GET') {
      // GET /api/redirect/loop-a — redirect into a loop
      return respond(
        new Response(null, {
          status: 302,
          headers: {
            location: `${new URL(req.url).origin}/api/redirect/loop-b`,
          },
        }),
      );
    } else if (path === '/api/redirect/loop-b' && req.method === 'GET') {
      // GET /api/redirect/loop-b — redirect back into the loop
      return respond(
        new Response(null, {
          status: 302,
          headers: {
            location: `${new URL(req.url).origin}/api/redirect/loop-a`,
          },
        }),
      );
    } else if (path === '/api/redirect/echo-method') {
      // GET /api/redirect/echo-method — echo the method/body seen after redirect
      const text = await req.text();
      return respond(Response.json({ method: req.method, body: text }));
    } else if (path === '/api/binary' && req.method === 'GET') {
      // GET /api/binary — 2048 bytes of binary data (0-255 repeating) with explicit
      // Content-Length so download progress is length-computable in node-adapter tests.
      const bytes = new Uint8Array(2048);

      for (let i = 0; i < 2048; i++) {
        bytes[i] = i % 256;
      }

      return respond(
        new Response(bytes, {
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': '2048',
          },
        }),
      );
    } else if (path === '/api/chunked' && req.method === 'GET') {
      // GET /api/chunked — streams 3 chunks with no Content-Length header.
      // Uses ReadableStream type:"direct" + flush() to force Bun to emit
      // Transfer-Encoding: chunked instead of buffering and setting Content-Length.
      // Used by NodeAdapter tests to verify progress: -1 when length is unknown.

      const source: Bun.DirectUnderlyingSource<string> = {
        type: 'direct',
        async pull(controller: ReadableStreamDirectController) {
          await controller.write('chunk-one ');
          await controller.flush();
          await controller.write('chunk-two ');
          await controller.flush();
          await controller.write('chunk-three');
          controller.close();
        },
      };

      const stream = new ReadableStream(
        source as unknown as UnderlyingSource<string>,
      );

      return respond(
        new Response(stream, { headers: { 'content-type': 'text/plain' } }),
      );
    } else if (path === '/api/no-content' && req.method === 'GET') {
      // GET /api/no-content — 204
      return respond(new Response(null, { status: 204 }));
    } else if (path === '/api/update' && req.method === 'PUT') {
      // PUT /api/update — echo body
      let body: unknown = null;

      try {
        body = await req.json();
      } catch {
        body = await req.text();
      }

      return respond(Response.json({ updated: true, data: body }));
    } else if (path === '/api/patch' && req.method === 'PATCH') {
      // PATCH /api/patch — echo body
      let body: unknown = null;

      try {
        body = await req.json();
      } catch {
        body = await req.text();
      }

      return respond(Response.json({ patched: true, data: body }));
    } else if (path.startsWith('/api/users/') && req.method === 'DELETE') {
      // DELETE /api/users/:id
      const id = path.slice('/api/users/'.length);
      return respond(Response.json({ deleted: true, id }));
    } else if (path === '/api/upload-hash' && req.method === 'POST') {
      // POST /api/upload-hash — reads a single file field named "file" from
      // FormData and returns the sha256 hex digest of its bytes. Used by
      // integrity tests to verify file content survives the upload unchanged.
      let hash = '';

      try {
        const form = await req.formData();
        const entry = form.get('file');

        if (entry instanceof File) {
          const bytes = await entry.arrayBuffer();
          hash = crypto
            .createHash('sha256')
            .update(Buffer.from(bytes))
            .digest('hex');
        }
      } catch {
        // fall through — hash stays empty string
      }

      return respond(Response.json({ hash }));
    } else if (path === '/api/raw-upload-hash' && req.method === 'POST') {
      // POST /api/raw-upload-hash — reads the raw request body and returns the
      // sha256 hex digest. Used to verify raw binary (Uint8Array) uploads arrive
      // intact, as opposed to /api/upload-hash which expects FormData.
      const bytes = await req.arrayBuffer();
      const hash = crypto
        .createHash('sha256')
        .update(Buffer.from(bytes))
        .digest('hex');
      return respond(Response.json({ hash }));
    } else if (path === '/api/head' && req.method === 'HEAD') {
      // HEAD /api/test
      return respond(
        new Response(null, {
          status: 200,
          headers: { 'x-head-ok': 'true' },
        }),
      );
    } else {
      return respond(Response.json({ error: 'not found' }, { status: 404 }));
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
