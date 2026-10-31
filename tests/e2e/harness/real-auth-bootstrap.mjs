import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { Client } from 'pg';

import { authEnvironment } from './real-auth-config.mjs';

const dbUrl = 'postgresql://lending@127.0.0.1:5433/lending_e2e';
const admin = new Client({
  connectionString: 'postgresql://lending@127.0.0.1:5433/postgres',
});
await admin.connect();
await admin.query('drop database if exists lending_e2e with (force)');
await admin.query('create database lending_e2e');
await admin.end();
const db = new Client({ connectionString: dbUrl });
await db.connect();
await db.query('create schema auth');
for (const role of [
  'postgres',
  'supabase_auth_admin',
  'supabase_admin',
  'dashboard_user',
]) {
  if (!(await db.query('select 1 from pg_roles where rolname=$1', [role])).rowCount) {
    await db.query('create role ' + role + ' nologin');
  }
}
const binary = process.env.E2E_REAL_AUTH_BINARY;
if (!binary || !binary.startsWith('/'))
  throw new Error('An absolute real Auth binary path is required');
const migrated = spawnSync(binary, ['migrate'], {
  env: { ...process.env, ...authEnvironment },
  encoding: 'utf8',
});
if (migrated.status !== 0)
  throw new Error('Real Auth migrations failed; inspect the private isolated log.');
await db.query(
  'alter table auth.users alter column id set default gen_random_uuid(), alter column created_at set default now()',
);
await db.query(readFileSync('tests/helpers/supabase-shim.sql', 'utf8'));
for (const file of readdirSync('supabase/migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort()) {
  await db.query(readFileSync('supabase/migrations/' + file, 'utf8'));
}
await db.query(`create function public.real_auth_request_context_probe() returns jsonb language sql stable security invoker set search_path='' as $$
select pg_catalog.jsonb_build_object('path',pg_catalog.current_setting('request.path',true),'method',pg_catalog.current_setting('request.method',true)) $$;
grant execute on function public.real_auth_request_context_probe() to anon,authenticated;`);
await db.end();
console.log(
  'Real Auth schema and application migrations installed in disposable lending_e2e.',
);
