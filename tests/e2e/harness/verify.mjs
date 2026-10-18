/**
 * Prove the stack can actually sign somebody in, before Playwright starts.
 *
 * ## Why this exists
 *
 * The browser suite has failed in CI with four timeouts in `auth.setup.ts` and
 * 519 specs "did not run". Nothing in that output says what broke: `/login`
 * rendered, the form was filled, the button was clicked, and the page simply
 * never navigated. The stack had come up far enough to serve a page and not
 * far enough to authenticate, and `stack.sh up` reported success either way,
 * because its readiness probes ask only whether a port answers.
 *
 * Two of those probes are weaker than they look. `curl -skf` against the shim
 * passes `-k`, so it does not validate the certificate the application will
 * validate; and `curl -sf /login` proves Next is serving, not that Next can
 * reach the shim. A stack that fails exactly between those two points — the
 * one that produces the CI symptom — passes both.
 *
 * So this checks the two things the probes do not:
 *
 *   1. **The shim's TLS is acceptable to Node with the harness CA**, which is
 *      what the application's `fetch` does. Not `-k`.
 *   2. **A real sign-in through the application redirects away from
 *      `/login`**, which exercises proxy, Server Action, shim, PostgREST and
 *      the session cookie in one go — the whole path `auth.setup.ts` needs.
 *
 * A failure here fails `stack.sh up` with the reason, so CI says what is
 * wrong in the step that is wrong, rather than in 4 timeouts twenty minutes
 * later.
 *
 * Nothing secret is printed. The credentials are the harness's own synthetic
 * ones and the phone numbers are in the reserved `+2567721xxxxx` range; this
 * prints neither, only which check failed and why.
 */
import { readFileSync } from 'node:fs';
import { connect } from 'node:tls';

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
const SHIM = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://127.0.0.1:8443';
const PASSWORD = process.env.HARNESS_PASSWORD ?? 'Screenshot#Demo2026';
const APIKEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_harness_only_key';

function fail(check, reason) {
  console.error(`harness check failed: ${check}`);
  console.error(`  ${reason}`);
  process.exit(1);
}

/** 1. The shim's certificate, validated the way the application validates it. */
async function checkShimTls() {
  const { hostname, port } = new URL(SHIM);

  await new Promise((resolve) => {
    const socket = connect(
      {
        host: hostname,
        port: Number(port),
        // RFC 6066 forbids an IP as the server name, and Node warns about it.
        ...(/^[0-9.]+$/.test(hostname) ? {} : { servername: hostname }),
        // Deliberately NOT `rejectUnauthorized: false`. The point is to fail
        // here if the application would fail, and the application does not
        // pass `-k`. NODE_EXTRA_CA_CERTS supplies the harness CA.
        rejectUnauthorized: true,
      },
      () => {
        socket.end();
        resolve();
      },
    );
    socket.on('error', (err) => {
      fail(
        'the shim’s TLS certificate is not acceptable to Node',
        `${err.code ?? err.name}: ${err.message}. ` +
          'The application reaches the shim over TLS from a Server Action, so ' +
          'sign-in fails while /login still renders. Check that ' +
          'NODE_EXTRA_CA_CERTS points at .e2e/cert.pem and that the ' +
          'certificate carries subjectAltName for 127.0.0.1.',
      );
    });
  });
}

/** 2. Every service is still listening. They are started detached; prove it. */
async function checkAlive(label, url, init) {
  try {
    const response = await fetch(url, { redirect: 'manual', ...init });
    return response;
  } catch (err) {
    fail(
      `${label} is not reachable`,
      `${err.cause?.code ?? err.name}: ${err.message}. The service was ` +
        'started by `stack.sh up`; if it was alive then and is gone now, it ' +
        'was killed with the process group of the step that started it.',
    );
    return undefined;
  }
}

/** 3. A real sign-in, through the shim the application signs in against. */
async function checkSignIn() {
  const fixtures = JSON.parse(
    readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'),
  );
  const phone = fixtures.staff?.owner;
  if (typeof phone !== 'string' || phone === '') {
    fail('fixtures.json has no owner account', 'Did the seed run?');
  }

  // `/login` must render — the suite's first action is `page.goto('/login')`.
  const page = await checkAlive('the application', `${BASE}/login`);
  if (page.status !== 200) {
    fail('/login did not render', `HTTP ${String(page.status)} from ${BASE}/login`);
  }

  // The password grant, with the same address derivation the application uses
  // (`authEmailForPhone`: the E.164 number without its `+`, at the reserved
  // auth domain). This is the call the sign-in Server Action makes, so it
  // fails here for the same reasons it fails there — and unlike the `curl -k`
  // probe it validates the certificate.
  const email = `${phone.slice(1)}@phone.lending.invalid`;
  const token = await checkAlive(
    'the auth shim',
    `${SHIM}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: APIKEY },
      body: JSON.stringify({ email, password: PASSWORD }),
    },
  );

  if (token.status !== 200) {
    fail(
      'the seeded owner could not sign in',
      `HTTP ${String(token.status)} from the shim's password grant. ` +
        'If this is 400, the seed and fixtures.json disagree about the ' +
        'account; if it is 5xx, the shim cannot reach PostgREST or the ' +
        'database.',
    );
  }

  const payload = await token.json().catch(() => ({}));
  if (typeof payload.access_token !== 'string') {
    fail(
      'the password grant returned no access token',
      'The shim answered 200 without one.',
    );
  }
}

await checkShimTls();
console.log('  shim TLS validates against the harness CA');

await checkAlive(
  'PostgREST',
  `${process.env.E2E_POSTGREST_URL ?? 'http://127.0.0.1:3001'}/`,
);
console.log('  postgrest reachable');

await checkSignIn();
console.log('  the seeded owner can sign in');
