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

// ---------------------------------------------------------------------------
// Revocation fixtures (CRL tests)
// ---------------------------------------------------------------------------

export interface RevocationFixtures {
  /** CA that issued both leaves below. */
  caCert: string;
  /** Leaf listed in crlRevoked. */
  revoked: { cert: string; key: string };
  /** Leaf from the same CA that was never revoked. */
  good: { cert: string; key: string };
  /** CRL from the issuing CA with nothing revoked yet. */
  crlEmpty: string;
  /** CRL from the issuing CA listing the `revoked` leaf. */
  crlRevoked: string;
  /** A second, unrelated root — used to test bundles and CRL coverage. */
  unrelatedCACert: string;
  /** The unrelated root's CRL. Covers nothing in the chains above. */
  unrelatedCRL: string;
}

let cachedRevocation: RevocationFixtures | null = null;

/**
 * Builds a CA that can actually revoke, which the simple `x509 -req` flow
 * above cannot: issuing a CRL needs `openssl ca` with its index/serial
 * database. Generated once per process — it costs several openssl invocations.
 */
export function getRevocationFixtures(): RevocationFixtures {
  if (cachedRevocation) {
    return cachedRevocation;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crl-test-'));

  try {
    const run = (cmd: string) => execSync(cmd, { stdio: 'pipe', cwd: dir });
    const p = (name: string) => path.join(dir, name);
    const read = (name: string) => fs.readFileSync(p(name), 'utf8');

    // `openssl ca` needs a config plus an index/serial/crlnumber database.
    const makeCA = (slug: string, commonName: string) => {
      fs.mkdirSync(p(`${slug}/newcerts`), { recursive: true });
      fs.writeFileSync(p(`${slug}/index.txt`), '');
      fs.writeFileSync(p(`${slug}/serial`), '1000\n');
      fs.writeFileSync(p(`${slug}/crlnumber`), '1000\n');
      fs.writeFileSync(
        p(`${slug}.cnf`),
        [
          '[ ca ]',
          'default_ca = CA_default',
          '[ CA_default ]',
          `dir = ./${slug}`,
          'database = $dir/index.txt',
          'new_certs_dir = $dir/newcerts',
          'certificate = $dir/ca.crt',
          'private_key = $dir/ca.key',
          'serial = $dir/serial',
          'crlnumber = $dir/crlnumber',
          'default_md = sha256',
          'default_days = 1',
          'default_crl_days = 1',
          'policy = policy_any',
          'email_in_dn = no',
          'unique_subject = no',
          '[ policy_any ]',
          'commonName = supplied',
          '[ req ]',
          'distinguished_name = req_dn',
          '[ req_dn ]',
          '[ SAN ]',
          'subjectAltName = DNS:localhost,IP:127.0.0.1',
          '',
        ].join('\n'),
      );
      run(
        `openssl ecparam -genkey -name prime256v1 -noout -out "${p(`${slug}/ca.key`)}"`,
      );
      run(
        `openssl req -new -x509 -days 1 -key "${p(`${slug}/ca.key`)}" -out "${p(`${slug}/ca.crt`)}" -subj "/CN=${commonName}"`,
      );
    };

    const issue = (slug: string, name: string) => {
      run(
        `openssl ecparam -genkey -name prime256v1 -noout -out "${p(`${name}.key`)}"`,
      );
      run(
        `openssl req -new -key "${p(`${name}.key`)}" -out "${p(`${name}.csr`)}" -subj "/CN=localhost"`,
      );
      run(
        `openssl ca -batch -config "${p(`${slug}.cnf`)}" -in "${p(`${name}.csr`)}" -out "${p(`${name}.crt`)}" -extensions SAN -extfile "${p(`${slug}.cnf`)}"`,
      );
      return { cert: read(`${name}.crt`), key: read(`${name}.key`) };
    };

    const gencrl = (slug: string, out: string) => {
      run(`openssl ca -config "${p(`${slug}.cnf`)}" -gencrl -out "${p(out)}"`);
      return read(out);
    };

    makeCA('issuer', 'Revocation Test CA');
    makeCA('other', 'Unrelated Root');

    const revoked = issue('issuer', 'revoked-leaf');
    const good = issue('issuer', 'good-leaf');

    // Snapshot a CRL before revoking, so tests can prove the CRL is what
    // changes the outcome rather than merely being present.
    const crlEmpty = gencrl('issuer', 'crl-empty.pem');

    run(
      `openssl ca -config "${p('issuer.cnf')}" -revoke "${p('revoked-leaf.crt')}"`,
    );

    const crlRevoked = gencrl('issuer', 'crl-revoked.pem');

    cachedRevocation = {
      caCert: read('issuer/ca.crt'),
      revoked,
      good,
      crlEmpty,
      crlRevoked,
      unrelatedCACert: read('other/ca.crt'),
      unrelatedCRL: gencrl('other', 'crl-other.pem'),
    };

    return cachedRevocation;
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

/**
 * Whether THIS runtime actually enforces the `crl` option.
 *
 * Bun ignored `crl` entirely through 1.3.14 — it accepted a revoked
 * certificate with no error — and implemented it in 1.4.0. Rather than gate on
 * a version number, ask the runtime directly with the same fixtures the tests
 * use, so the enforcement tests switch themselves on wherever `crl` works and
 * a future regression shows up as skipped tests rather than green ones.
 *
 * Probing is not a substitute for testing our own behaviour: the normalization
 * this adapter performs is asserted separately and runs everywhere.
 */
export async function detectCRLEnforcement(): Promise<boolean> {
  const fixtures = getRevocationFixtures();
  const server = await startTlsTestServerWith(fixtures.revoked);
  const { hostname, port } = new URL(server.url);

  try {
    return await new Promise<boolean>((resolve) => {
      const req = https.request(
        {
          host: hostname,
          port: Number(port),
          path: '/',
          agent: false,
          ca: fixtures.caCert,
          crl: fixtures.crlRevoked,
        },
        (res) => {
          res.resume();
          // Connected to a revoked certificate: not enforcing.
          res.on('end', () => resolve(false));
        },
      );

      req.on('error', () => resolve(true));
      req.end();
    });
  } finally {
    await server.stop();
  }
}

/** Starts an HTTPS server presenting a specific leaf — used by CRL tests. */
export function startTlsTestServerWith(leaf: {
  cert: string;
  key: string;
}): Promise<TlsTestServer> {
  return startServer(leaf.cert, leaf.key);
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
