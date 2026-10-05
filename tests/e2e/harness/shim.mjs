/**
 * A Supabase-compatible front door for the screenshot harness.
 *
 * The application talks to a Supabase project over HTTPS: PostgREST under
 * `/rest/v1` and GoTrue under `/auth/v1`. A hosted project is not available
 * here and `supabase start` needs Docker, which this container does not have.
 *
 * So this serves the real PostgREST (downloaded, 12.2.3) behind `/rest/v1`,
 * and implements the small slice of GoTrue the application actually uses:
 * password sign-in, token refresh, the current user, a password update, and
 * sign-out. Nothing about the application is changed or stubbed — it runs
 * against a real PostgreSQL with the real migrations, the real Row Level
 * Security and the real privileges, which is why PostgREST refuses `anon`
 * reads exactly as the schema intends.
 *
 * HARNESS ONLY. The JWT secret and the certificate below are throwaway values
 * generated for this container; nothing here is a credential for anything.
 */
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { createHmac, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire('/home/user/lending-manager/package.json');
const { Client } = require('pg');

const JWT_SECRET = 'harness-only-jwt-secret-not-a-real-key-32+';
// The two API keys the application presents. Read from the environment so
// the shim and `stack.sh env` cannot drift apart: when they did, the
// privileged client's key was not recognised, the request fell back to
// `anon`, `consume_rate_limit` is deliberately not granted to `anon`, and
// every sign-in was refused by its own rate limiter.
const PUBLISHABLE_KEY =
  process.env.E2E_PUBLISHABLE_KEY ?? 'sb_publishable_harness_only_key';
const SECRET_KEY = process.env.E2E_SECRET_KEY ?? 'sb_secret_harness_only_key';
const RUN_DIR = process.env.E2E_RUN_DIR ?? new URL('.', import.meta.url).pathname;
const PORT = Number(process.env.E2E_SHIM_PORT ?? 8443);
const POSTGREST = {
  host: '127.0.0.1',
  port: Number(process.env.E2E_POSTGREST_PORT ?? 3001),
};

const db = new Client({
  connectionString:
    process.env.E2E_DATABASE_URL ??
    `postgresql://${process.env.E2E_PG_USER ?? 'lending'}@127.0.0.1:${process.env.E2E_PG_PORT ?? '5433'}/${process.env.E2E_PG_DB ?? 'lending_e2e'}`,
});
await db.connect();

// ---------------------------------------------------------------------------
// JWT, HS256
// ---------------------------------------------------------------------------
const b64url = (input) =>
  Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

function signJwt(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${body}.${signature}`;
}

function verifyJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expected = createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  if (signature !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------
function verifyPassword(stored, plain) {
  if (typeof stored !== 'string') return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || salt === undefined || hash === undefined) return false;
  const candidate = scryptSync(plain, salt, 64).toString('hex');
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function hashPassword(plain) {
  const salt = randomUUID().replace(/-/g, '');
  return `scrypt$${salt}$${scryptSync(plain, salt, 64).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
const refreshTokens = new Map(); // refresh token -> auth user id
const SESSION_SECONDS = 60 * 60 * 8;

function gotrueUser(row) {
  return {
    id: row.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: row.email,
    email_confirmed_at: row.created_at,
    confirmed_at: row.created_at,
    phone: '',
    last_sign_in_at: new Date().toISOString(),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: row.created_at,
    updated_at: row.created_at,
    is_anonymous: false,
  };
}

function issueSession(row) {
  const now = Math.floor(Date.now() / 1000);
  const refresh = randomUUID().replace(/-/g, '');
  refreshTokens.set(refresh, row.id);

  const accessToken = signJwt({
    sub: row.id,
    email: row.email,
    role: 'authenticated',
    aud: 'authenticated',
    iss: `https://localhost:${String(PORT)}/auth/v1`,
    iat: now,
    exp: now + SESSION_SECONDS,
    session_id: randomUUID(),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    is_anonymous: false,
  });

  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: SESSION_SECONDS,
    expires_at: now + SESSION_SECONDS,
    refresh_token: refresh,
    user: gotrueUser(row),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

function send(res, status, payload, headers = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    ...headers,
  });
  res.end(body);
}

const authError = (res, status, message, code) =>
  send(res, status, { code: status, error_code: code, msg: message, message });

function bearer(req) {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

// ---------------------------------------------------------------------------
// GoTrue subset
// ---------------------------------------------------------------------------
async function handleAuth(req, res, url) {
  const path = url.pathname.replace('/auth/v1', '');

  if (path === '/.well-known/jwks.json') {
    // Empty, deliberately: the tokens are HS256, and supabase-js falls back to
    // verifying them through /user when there is no asymmetric key.
    return send(res, 200, { keys: [] });
  }

  if (path === '/health' || path === '/settings') {
    return send(res, 200, {
      external: {},
      disable_signup: true,
      mailer_autoconfirm: true,
    });
  }

  if (path === '/token' && req.method === 'POST') {
    const grant = url.searchParams.get('grant_type');
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');

    if (grant === 'password') {
      const { rows } = await db.query(
        `select id, email, created_at, encrypted_password from auth.users where email = $1`,
        [String(body.email ?? '').toLowerCase()],
      );
      const user = rows[0];

      if (
        user === undefined ||
        !verifyPassword(user.encrypted_password, String(body.password ?? ''))
      ) {
        return authError(res, 400, 'Invalid login credentials', 'invalid_credentials');
      }

      return send(res, 200, issueSession(user));
    }

    if (grant === 'refresh_token') {
      const id = refreshTokens.get(String(body.refresh_token ?? ''));
      if (id === undefined) {
        return authError(res, 400, 'Invalid Refresh Token', 'refresh_token_not_found');
      }
      refreshTokens.delete(String(body.refresh_token));
      const { rows } = await db.query(
        `select id, email, created_at from auth.users where id = $1`,
        [id],
      );
      if (rows[0] === undefined) {
        return authError(res, 400, 'Invalid Refresh Token', 'refresh_token_not_found');
      }
      return send(res, 200, issueSession(rows[0]));
    }

    return authError(res, 400, 'Unsupported grant type', 'unsupported_grant_type');
  }

  if (path === '/user' && req.method === 'GET') {
    const token = bearer(req);
    const claims = token === null ? null : verifyJwt(token);
    if (claims === null)
      return authError(res, 401, 'invalid claim: missing sub claim', 'bad_jwt');

    const { rows } = await db.query(
      `select id, email, created_at from auth.users where id = $1`,
      [claims.sub],
    );
    if (rows[0] === undefined)
      return authError(
        res,
        403,
        'User from sub claim in JWT does not exist',
        'user_not_found',
      );

    return send(res, 200, gotrueUser(rows[0]));
  }

  if (path === '/user' && req.method === 'PUT') {
    const token = bearer(req);
    const claims = token === null ? null : verifyJwt(token);
    if (claims === null)
      return authError(res, 401, 'invalid claim: missing sub claim', 'bad_jwt');

    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (typeof body.password === 'string' && body.password.length > 0) {
      await db.query(`update auth.users set encrypted_password = $2 where id = $1`, [
        claims.sub,
        hashPassword(body.password),
      ]);
    }

    const { rows } = await db.query(
      `select id, email, created_at from auth.users where id = $1`,
      [claims.sub],
    );
    return send(res, 200, gotrueUser(rows[0]));
  }

  if (path === '/logout' && req.method === 'POST') {
    res.writeHead(204, { 'access-control-allow-origin': '*' });
    return res.end();
  }

  // Admin: enough for the staff-account screens to work.
  if (path.startsWith('/admin/users')) {
    const token = bearer(req);
    if (token !== SECRET_KEY) return authError(res, 403, 'User not allowed', 'not_admin');

    const id = path.replace('/admin/users', '').replace(/^\//, '');

    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const { rows } = await db.query(
        `insert into auth.users (email, encrypted_password) values ($1, $2)
         returning id, email, created_at`,
        [
          String(body.email ?? '').toLowerCase(),
          hashPassword(String(body.password ?? randomUUID())),
        ],
      );
      return send(res, 200, gotrueUser(rows[0]));
    }

    if (req.method === 'PUT' && id !== '') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (typeof body.password === 'string') {
        await db.query(`update auth.users set encrypted_password = $2 where id = $1`, [
          id,
          hashPassword(body.password),
        ]);
      }
      const { rows } = await db.query(
        `select id, email, created_at from auth.users where id = $1`,
        [id],
      );
      return send(res, 200, gotrueUser(rows[0]));
    }

    if (req.method === 'DELETE' && id !== '') {
      await db.query(`delete from auth.users where id = $1`, [id]);
      return send(res, 200, {});
    }
  }

  return authError(res, 404, 'Not found', 'not_found');
}

// ---------------------------------------------------------------------------
// PostgREST passthrough
// ---------------------------------------------------------------------------
function handleRest(req, res, url, body) {
  const token = bearer(req);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];

  if (token === SECRET_KEY) {
    // The application's privileged client. PostgREST switches into
    // `service_role` from the role claim, which is how a hosted project does
    // it too.
    const now = Math.floor(Date.now() / 1000);
    headers.authorization = `Bearer ${signJwt({ role: 'service_role', iat: now, exp: now + 300 })}`;
  } else if (token === null || token === PUBLISHABLE_KEY || verifyJwt(token) === null) {
    // No session: let PostgREST fall back to its anon role rather than trying
    // to parse the publishable key as a JWT.
    delete headers.authorization;
  }

  const target = url.pathname.replace('/rest/v1', '') + (url.search ?? '');

  const proxied = httpRequest(
    {
      host: POSTGREST.host,
      port: POSTGREST.port,
      method: req.method,
      path: target,
      headers,
    },
    (upstream) => {
      res.writeHead(upstream.statusCode ?? 500, upstream.headers);
      upstream.pipe(res);
    },
  );

  proxied.on('error', (error) => {
    send(res, 502, { message: `PostgREST unreachable: ${String(error)}` });
  });

  if (body !== undefined && body.length > 0) proxied.write(body);
  proxied.end();
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = createServer(
  {
    key: readFileSync(`${RUN_DIR}/key.pem`),
    cert: readFileSync(`${RUN_DIR}/cert.pem`),
  },
  (req, res) => {
    const url = new URL(req.url ?? '/', `https://localhost:${String(PORT)}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      });
      return res.end();
    }

    if (url.pathname.startsWith('/auth/v1')) {
      return void handleAuth(req, res, url).catch((error) => {
        send(res, 500, { message: String(error) });
      });
    }

    if (url.pathname.startsWith('/rest/v1')) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        return handleRest(req, res, url, undefined);
      }
      return void readBody(req).then((body) => handleRest(req, res, url, body));
    }

    return send(res, 404, { message: 'Not found' });
  },
);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`supabase shim listening on https://127.0.0.1:${String(PORT)}`);
});
