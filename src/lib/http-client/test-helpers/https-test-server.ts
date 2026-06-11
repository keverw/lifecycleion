import * as https from 'node:https';
import type * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

interface GeneratedCerts {
  caCert: string;
  // Server cert with both DNS:localhost and IP:127.0.0.1 SANs
  serverCert: string;
  serverKey: string;
  // Server cert with only DNS:localhost SAN — no IP. Used to test servername:
  // dialing by IP without servername fails; with servername it succeeds.
  serverCertDnsOnly: string;
  serverKeyDnsOnly: string;
}

// Generated once per process and reused across test suites.
let cachedCerts: GeneratedCerts | null = null;

function generateCerts(): GeneratedCerts {
  if (cachedCerts) {
    return cachedCerts;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-test-'));

  try {
    const sanFull = path.join(dir, 'san-full.cnf');
    const sanDnsOnly = path.join(dir, 'san-dns.cnf');
    fs.writeFileSync(
      sanFull,
      '[SAN]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n',
    );
    fs.writeFileSync(sanDnsOnly, '[SAN]\nsubjectAltName=DNS:localhost\n');

    const run = (cmd: string) => execSync(cmd, { stdio: 'pipe' });
    const p = (name: string) => path.join(dir, name);

    // EC keys are near-instant to generate
    run(
      `openssl ecparam -genkey -name prime256v1 -noout -out "${p('ca.key')}"`,
    );
    run(
      `openssl req -new -x509 -days 1 -key "${p('ca.key')}" -out "${p('ca.crt')}" -subj "/CN=Test CA"`,
    );

    // Server cert with IP SAN (for standard CA tests)
    run(
      `openssl ecparam -genkey -name prime256v1 -noout -out "${p('server.key')}"`,
    );
    run(
      `openssl req -new -key "${p('server.key')}" -out "${p('server.csr')}" -subj "/CN=localhost"`,
    );
    run(
      `openssl x509 -req -days 1 -in "${p('server.csr')}" -CA "${p('ca.crt')}" -CAkey "${p('ca.key')}" -CAcreateserial -out "${p('server.crt')}" -extensions SAN -extfile "${sanFull}"`,
    );

    // Server cert with DNS-only SAN (for servername tests — no IP SAN means
    // dialing by IP fails unless servername overrides the verification hostname)
    run(
      `openssl ecparam -genkey -name prime256v1 -noout -out "${p('server-dns.key')}"`,
    );
    run(
      `openssl req -new -key "${p('server-dns.key')}" -out "${p('server-dns.csr')}" -subj "/CN=localhost"`,
    );
    run(
      `openssl x509 -req -days 1 -in "${p('server-dns.csr')}" -CA "${p('ca.crt')}" -CAkey "${p('ca.key')}" -CAcreateserial -out "${p('server-dns.crt')}" -extensions SAN -extfile "${sanDnsOnly}"`,
    );

    cachedCerts = {
      caCert: fs.readFileSync(p('ca.crt'), 'utf8'),
      serverCert: fs.readFileSync(p('server.crt'), 'utf8'),
      serverKey: fs.readFileSync(p('server.key'), 'utf8'),
      serverCertDnsOnly: fs.readFileSync(p('server-dns.crt'), 'utf8'),
      serverKeyDnsOnly: fs.readFileSync(p('server-dns.key'), 'utf8'),
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

function startServer(cert: string, key: string): Promise<TlsTestServer> {
  return new Promise((resolve, reject) => {
    const server = https.createServer(
      { cert, key },
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

/**
 * Starts a minimal HTTPS server whose cert has both DNS:localhost and
 * IP:127.0.0.1 SANs. Use getTestCACert() as the `ca` option to trust it.
 */
export function startTlsTestServer(): Promise<TlsTestServer> {
  const { serverCert, serverKey } = generateCerts();
  return startServer(serverCert, serverKey);
}

/**
 * Starts a minimal HTTPS server whose cert has only a DNS:localhost SAN —
 * no IP SAN. Dialing by IP (127.0.0.1) without `servername` will fail TLS
 * verification. Use this to test that `servername: 'localhost'` fixes it.
 */
export function startTlsTestServerDnsOnly(): Promise<TlsTestServer> {
  const { serverCertDnsOnly, serverKeyDnsOnly } = generateCerts();
  return startServer(serverCertDnsOnly, serverKeyDnsOnly);
}
