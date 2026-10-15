import { expect, test } from 'bun:test';
import * as http from 'node:http';
import { NodeAdapter } from './node-adapter';

test('NodeAdapter driven directly sends header names as given', async () => {
  let receivedRawHeaders: string[] = [];
  const server = http.createServer((req, res) => {
    receivedRawHeaders = req.rawHeaders;
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  try {
    const response = await new NodeAdapter().send({
      requestURL: `http://127.0.0.1:${port}/`,
      method: 'GET',
      headers: { 'X-Api-Key': 'k' },
    });

    expect(response.status).toBe(200);
    // A legacy server or signed-header scheme may read the name's case.
    expect(receivedRawHeaders).toContain('X-Api-Key');
    // What is reported as sent stays lowercased, as every effective header is.
    expect(response.effectiveRequestHeaders?.['x-api-key']).toBe('k');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
