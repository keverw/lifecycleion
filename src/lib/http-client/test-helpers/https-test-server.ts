import * as https from 'node:https';
import type * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

interface GeneratedCerts {
  caCert: string;
  serverCert: string;
  serverKey: string;
}

// Generated once per process and reused across test suites.
let cachedCerts: GeneratedCerts | null = null;

function generateCerts(): GeneratedCerts {
  if (cachedCerts) {
    return cachedCerts;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-test-'));

  try {
    const sanCfg = path.join(dir, 'san.cnf');
    fs.writeFileSync(
      sanCfg,
      '[SAN]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n',
    );

    // EC keys are near-instant to generate
    execSync(
      `openssl ecparam -genkey -name prime256v1 -noout -out "${path.join(dir, 'ca.key')}"`,
      { stdio: 'pipe' },
    );
    execSync(
      `openssl req -new -x509 -days 1 -key "${path.join(dir, 'ca.key')}" -out "${path.join(dir, 'ca.crt')}" -subj "/CN=Test CA"`,
      { stdio: 'pipe' },
    );
    execSync(
      `openssl ecparam -genkey -name prime256v1 -noout -out "${path.join(dir, 'server.key')}"`,
      { stdio: 'pipe' },
    );
    execSync(
      `openssl req -new -key "${path.join(dir, 'server.key')}" -out "${path.join(dir, 'server.csr')}" -subj "/CN=localhost"`,
      { stdio: 'pipe' },
    );
    execSync(
      `openssl x509 -req -days 1 -in "${path.join(dir, 'server.csr')}" -CA "${path.join(dir, 'ca.crt')}" -CAkey "${path.join(dir, 'ca.key')}" -CAcreateserial -out "${path.join(dir, 'server.crt')}" -extensions SAN -extfile "${sanCfg}"`,
      { stdio: 'pipe' },
    );

    cachedCerts = {
      caCert: fs.readFileSync(path.join(dir, 'ca.crt'), 'utf8'),
      serverCert: fs.readFileSync(path.join(dir, 'server.crt'), 'utf8'),
      serverKey: fs.readFileSync(path.join(dir, 'server.key'), 'utf8'),
    };

    return cachedCerts;
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

export function getTestCACert(): string {
  return generateCerts().caCert;
}

export interface TlsTestServer {
  url: string;
  stop: () => Promise<void>;
}

/**
 * Starts a minimal HTTPS server with a freshly generated self-signed CA.
 * The server responds to all requests with { ok: true }.
 * Use getTestCACert() as the `ca` option in NodeAdapterConfig to trust it.
 */
export function startTlsTestServer(): Promise<TlsTestServer> {
  const { serverCert, serverKey } = generateCerts();

  return new Promise((resolve, reject) => {
    const server = https.createServer(
      { cert: serverCert, key: serverKey },
      (_req: http.IncomingMessage, res: http.ServerResponse) => {
        res.setHeader('content-type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      },
    );

    server.on('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `https://127.0.0.1:${addr.port}`,
        stop: () =>
          new Promise<void>((res, rej) =>
            server.close((e) => (e ? rej(e) : res())),
          ),
      });
    });
  });
}
