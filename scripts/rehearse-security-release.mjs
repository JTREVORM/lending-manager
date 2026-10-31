import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';
import {
  applyScopedSecurityMigration,
  securityVersion,
} from './lib/scoped-security-migration.mjs';

const url = new URL(
  process.env.RELEASE_REHEARSAL_DB_URL ??
    'postgresql://lending@127.0.0.1:5433/lending_release_gate',
);
assert(
  ['localhost', '127.0.0.1'].includes(url.hostname) &&
    url.pathname === '/lending_release_gate',
  'Disposable local database only',
);
const binary = process.env.E2E_POSTGREST;
assert(binary?.startsWith('/'), 'Absolute PostgREST path required');
const evidence = {
  postgres: null,
  checks: [],
  historicalVersions: [],
  requestContexts: [],
};
const check = (name, condition) => {
  assert(condition, name);
  evidence.checks.push(name);
};
const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.href });
await admin.connect();
await admin.query('drop database if exists lending_release_gate with (force)');
await admin.query('create database lending_release_gate');
await admin.end();
const db = new Client({ connectionString: url.href });
await db.connect();
let server;
const root = new URL('../', import.meta.url);
const manifestPath = new URL('tests/e2e/harness/fixtures.json', root);
const originalManifest = readFileSync(manifestPath);
try {
  evidence.postgres = (await db.query('show server_version')).rows[0].server_version;
  check('PostgreSQL 17 execution', evidence.postgres.startsWith('17.'));
  await db.query(readFileSync(new URL('tests/helpers/supabase-shim.sql', root), 'utf8'));
  await db.query(
    'create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key, name text, statements text[])',
  );
  for (const f of readdirSync(new URL('supabase/migrations/', root))
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (f.startsWith(securityVersion)) continue;
    const sql = readFileSync(new URL('supabase/migrations/' + f, root), 'utf8');
    await db.query(sql);
    await db.query('insert into supabase_migrations.schema_migrations values($1,$2,$3)', [
      f.slice(0, 14),
      f.slice(15, -4),
      [sql],
    ]);
  }
  const extras = [
    { name: 'collateral', version: '20261010104426' },
    { name: 'recovery_actions', version: '20261010104529' },
    { name: 'guarantee_release', version: '20261010104621' },
    { name: 'risk_monitoring', version: '20261010104723' },
    { name: 'notifications', version: '20261011060140' },
    { name: 'notification_triggers', version: '20261011060324' },
    { name: 'notification_backfill', version: '20261011061348' },
    { name: 'balance_as_of', version: '20261012062453' },
    { name: 'notify_what_still_waits', version: '20261012064058' },
  ];
  for (const e of extras)
    await db.query('insert into supabase_migrations.schema_migrations values($1,$2,$3)', [
      e.version,
      e.name,
      [],
    ]);
  evidence.historicalVersions = extras.map((x) => x.version);
  await db.query(`alter table auth.users add column encrypted_password text;
    create or replace function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
        nullif(current_setting('request.jwt.claims',true),'')::json->>'sub')::uuid $$;`);
  if (
    !(await db.query("select 1 from pg_roles where rolname='release_authenticator'"))
      .rowCount
  ) {
    await db.query(
      "create role release_authenticator noinherit login password 'e2e-harness-only'",
    );
  }
  await db.query(
    'grant anon,authenticated,service_role to release_authenticator; grant usage on schema public,auth to release_authenticator; alter role release_authenticator reset pgrst.db_pre_request',
  );
  const seeded = spawnSync(process.execPath, ['tests/e2e/harness/seed.mjs'], {
    cwd: root.pathname,
    env: { ...process.env, E2E_DATABASE_URL: url.href },
    encoding: 'utf8',
  });
  assert.equal(seeded.status, 0, 'Synthetic seed failed (private logs only)');
  const fixtures = JSON.parse(readFileSync(manifestPath, 'utf8'));
  writeFileSync(manifestPath, originalManifest);
  const snapshot = async () => {
    const names = (
      await db.query(
        "select tablename from pg_tables where schemaname='public' order by tablename",
      )
    ).rows.map((r) => r.tablename);
    const data = {};
    for (const n of names) {
      assert(/^[a-z_]+$/.test(n));
      data[n] = (
        await db.query(
          "select count(*)::int as n, md5(coalesce(string_agg(j,'' order by j),'')) as hash from (select row_to_json(t)::text j from public.\"" +
            n +
            '" t) x',
        )
      ).rows[0];
    }
    return data;
  };
  const policyHash = async () =>
    (
      await db.query(
        "select md5(string_agg(row_to_json(p)::text,'' order by schemaname,tablename,policyname)) h from pg_policies p where schemaname in ('public','storage')",
      )
    ).rows[0].h;
  const baseline = await snapshot();
  const policies = await policyHash();
  const historyBefore = (
    await db.query(
      'select version,name from supabase_migrations.schema_migrations order by version',
    )
  ).rows;
  await db.query(`create function public.release_legacy_hook() returns void language plpgsql volatile security invoker set search_path='' as $$
    begin perform pg_catalog.set_config('app.legacy_hook_seen','yes',true); end $$;
    create function public.release_context_probe() returns jsonb language sql stable security invoker set search_path='' as $$
      select pg_catalog.jsonb_build_object('path',pg_catalog.current_setting('request.path',true),
      'method',pg_catalog.current_setting('request.method',true),'legacy',pg_catalog.current_setting('app.legacy_hook_seen',true)) $$;
    grant execute on function public.release_legacy_hook(), public.release_context_probe() to anon,authenticated,service_role;`);
  const env = {
    ...process.env,
    PGRST_DB_URI:
      'postgres://release_authenticator:e2e-harness-only@127.0.0.1:5433/lending_release_gate',
    PGRST_DB_SCHEMAS: 'public',
    PGRST_DB_ANON_ROLE: 'anon',
    PGRST_SERVER_HOST: '127.0.0.1',
    PGRST_SERVER_PORT: '3301',
    PGRST_DB_PRE_REQUEST: 'public.release_legacy_hook',
    PGRST_JWT_SECRET: 'harness-only-jwt-secret-not-a-real-key-32+',
    PGRST_LOG_LEVEL: 'crit',
  };
  const start = () => {
    server = spawn(binary, [], { env, stdio: 'ignore' });
  };
  const request = async (path, token, method = 'GET', body) => {
    const r = await fetch('http://127.0.0.1:3301' + path, {
      method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    return { status: r.status, data: text ? JSON.parse(text) : null };
  };
  const wait = async (predicate) => {
    for (let i = 0; i < 60; i++) {
      try {
        if (await predicate()) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('Isolated service/configuration did not become ready');
  };
  start();
  await wait(async () => (await request('/rpc/polytos_readiness')).status === 200);
  // dump-config starts a temporary server too; use a free diagnostic port.
  const dump = spawnSync(binary, ['--dump-config'], {
    env: { ...env, PGRST_SERVER_PORT: '0' },
    encoding: 'utf8',
  });
  assert.equal(
    dump.status,
    0,
    'Redacted dump-config failed: ' + dump.stderr.slice(0, 160),
  );
  const hookLine = dump.stdout
    .split('\n')
    .find((l) => l.trimStart().startsWith('db-pre-request'));
  check(
    'Environment hook visible in redacted dump-config',
    hookLine?.includes('release_legacy_hook'),
  );
  const context = await request('/rpc/release_context_probe');
  evidence.requestContexts.push(context.data);
  check(
    'Actual HTTP context uses upstream /rpc path and method',
    context.data.path === '/rpc/release_context_probe' &&
      context.data.method === 'GET' &&
      context.data.legacy === 'yes',
  );
  await assert.rejects(
    applyScopedSecurityMigration(db, {
      beforeCommit: () => {
        throw new Error('rehearsed interruption');
      },
    }),
    /interruption/,
  );
  check(
    'Pre-commit interruption leaves no history row',
    (
      await db.query(
        'select 1 from supabase_migrations.schema_migrations where version=$1',
        [securityVersion],
      )
    ).rowCount === 0,
  );
  check(
    'Pre-commit interruption rolls back new hook function',
    (
      await db.query(
        "select to_regprocedure('public.enforce_password_change()') is null n",
      )
    ).rows[0].n,
  );
  assert.deepEqual(await snapshot(), baseline);
  const interrupted = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import {Client} from 'pg'; import {applyScopedSecurityMigration} from './scripts/lib/scoped-security-migration.mjs'; const c=new Client({connectionString:process.env.RELEASE_REHEARSAL_DB_URL}); await c.connect(); await applyScopedSecurityMigration(c,{beforeCommit:()=>process.kill(process.pid,'SIGKILL')});",
    ],
    {
      cwd: root.pathname,
      env: { ...process.env, RELEASE_REHEARSAL_DB_URL: url.href },
      encoding: 'utf8',
    },
  );
  check(
    'Hard interruption before commit terminates the executor',
    interrupted.signal === 'SIGKILL',
  );
  check(
    'Hard interruption leaves no canonical history row',
    (
      await db.query(
        'select 1 from supabase_migrations.schema_migrations where version=$1',
        [securityVersion],
      )
    ).rowCount === 0,
  );
  await applyScopedSecurityMigration(db);
  await assert.rejects(applyScopedSecurityMigration(db), /refusing replay/);
  check(
    'Canonical history recorded exactly once',
    (
      await db.query(
        'select count(*)::int n from supabase_migrations.schema_migrations where version=$1',
        [securityVersion],
      )
    ).rows[0].n === 1,
  );
  const historyAfter = (
    await db.query(
      'select version,name from supabase_migrations.schema_migrations where version<>$1 order by version',
      [securityVersion],
    )
  ).rows;
  assert.deepEqual(historyAfter, historyBefore);
  check('All nine historical discrepancies preserved', extras.length === 9);
  assert.deepEqual(await snapshot(), baseline);
  check('All public table counts and row fingerprints unchanged by migration', true);
  assert.equal(await policyHash(), policies);
  check('Public and Storage RLS policies unchanged', true);
  const encode = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tokenFor = async (phone) => {
    const row = (
      await db.query('select auth_user_id from public.profiles where phone=$1', [phone])
    ).rows[0];
    const unsigned =
      encode({ alg: 'HS256', typ: 'JWT' }) +
      '.' +
      encode({
        sub: row.auth_user_id,
        role: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 600,
      });
    return (
      unsigned +
      '.' +
      createHmac('sha256', env.PGRST_JWT_SECRET).update(unsigned).digest('base64url')
    );
  };
  const forced = await tokenFor(fixtures.staff.temporaryPassword),
    owner = await tokenFor(fixtures.staff.owner);
  const scalar =
    '/rpc/savings_pledged_amount?p_savings_account_id=00000000-0000-4000-8000-000000000001';
  check(
    'Before activation, RLS identity alone does not gate scalar definer RPC',
    (await request(scalar, forced)).status === 200,
  );
  await db.query(`create function public.release_gate_chain() returns void language plpgsql volatile security invoker set search_path='' as $$
    begin perform public.release_legacy_hook(); perform public.enforce_password_change(); end $$;
    grant execute on function public.release_gate_chain() to anon,authenticated,service_role;
    alter role release_authenticator set pgrst.db_pre_request='public.release_gate_chain';
    notify pgrst,'reload schema'; notify pgrst,'reload config';`);
  await wait(
    async () => (await request('/loans?select=id&limit=0', forced)).status === 403,
  );
  check('Role config reload overrides environment hook and enforces denial', true);
  const normal = await request('/rpc/release_context_probe', owner);
  check(
    'Chaining preserves existing hook in real HTTP context',
    normal.data.legacy === 'yes',
  );
  for (const path of ['/loans?select=id&limit=0', scalar])
    check('Forced request denied: ' + path, (await request(path, forced)).status === 403);
  check(
    'Normal Owner table reads preserved',
    (await request('/loans?select=id&limit=0', owner)).status === 200,
  );
  const bootstrap = await request('/rpc/current_session_context', forced, 'POST', {});
  check(
    'GET recovery bootstrap allowed over HTTP',
    (await request('/rpc/current_session_context', forced)).status === 200,
  );
  check(
    'Published branding allowed for forced recovery',
    (await request('/company_identity', forced)).status === 200,
  );
  check(
    'Readiness works for a forced JWT',
    (await request('/rpc/polytos_readiness', forced)).data === true,
  );
  check(
    'Readiness works for a normal JWT',
    (await request('/rpc/polytos_readiness', owner)).data === true,
  );
  check(
    'Forced recovery bootstrap allowed over HTTP',
    bootstrap.status === 200 && bootstrap.data[0].must_change_password === true,
  );
  for (const [path, body] of [
    ['/rpc/record_sign_in', {}],
    ['/rpc/record_security_event', { p_action: 'auth.signed_in' }],
    [
      '/rpc/consume_rate_limit',
      {
        p_bucket_key: createHash('sha256').update('release-rehearsal').digest('hex'),
        p_action: 'auth.password-change',
        p_limit: 5,
        p_window_seconds: 60,
      },
    ],
  ]) {
    const r = await request(path, forced, 'POST', body);
    check('Recovery security RPC allowed: ' + path, r.status >= 200 && r.status < 300);
  }
  check(
    'Public readiness remains exact true',
    (await request('/rpc/polytos_readiness')).data === true,
  );
  const objectName = 'clients/' + fixtures.clients.current + '/photo/release-gate.jpg';
  await db.query(
    "insert into storage.objects(bucket_id,name) values('client-documents',$1)",
    [objectName],
  );
  const storageVisible = async (token) => {
    const sub = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ).sub;
    await db.query('begin');
    try {
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [sub]);
      await db.query('set local role authenticated');
      return (
        await db.query('select count(*)::int n from storage.objects where name=$1', [
          objectName,
        ])
      ).rows[0].n;
    } finally {
      await db.query('rollback');
    }
  };
  check(
    'Storage object RLS permits the normal Owner',
    (await storageVisible(owner)) === 1,
  );
  check(
    'Storage object RLS denies the forced account without a PostgREST hook',
    (await storageVisible(forced)) === 0,
  );
  await new Promise((resolve) => {
    server.once('exit', resolve);
    server.kill('SIGKILL');
  });
  start();
  await wait(
    async () => (await request('/loans?select=id&limit=0', forced)).status === 403,
  );
  check('Post-activation interruption/restart preserves enforcement', true);
  check(
    'Readiness grant and service-only confirmation preserved',
    (
      await db.query(
        "select not has_function_privilege('authenticated','public.confirm_password_change(uuid)','execute') and has_function_privilege('anon','public.polytos_readiness()','execute') ok",
      )
    ).rows[0].ok,
  );
  const after = await snapshot();
  for (const name of [
    'loans',
    'loan_payments',
    'journal_entries',
    'journal_lines',
    'savings_accounts',
    'savings_transactions',
    'membership_policy_versions',
    'loan_installments',
  ])
    assert.deepEqual(after[name], baseline[name]);
  check(
    'Financial records, schedules and policy records unchanged through rehearsal',
    true,
  );
  evidence.financialFingerprints = Object.fromEntries(
    [
      'loans',
      'loan_payments',
      'journal_entries',
      'journal_lines',
      'savings_accounts',
      'savings_transactions',
      'membership_policy_versions',
    ].map((n) => [n, after[n]]),
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  writeFileSync(manifestPath, originalManifest);
  if (server) server.kill();
  await db.end();
}
