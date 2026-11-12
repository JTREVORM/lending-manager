/**
 * Behavioural authorization probe.
 *
 * Calls every SECURITY DEFINER function an `authenticated` session may execute,
 * as a borrower who holds no business capability, with NULL for every argument,
 * inside a transaction that is always rolled back. A guard placed at the top of
 * a function fires before it ever looks at its arguments, so the SQLSTATE that
 * comes back says whether an authorization check actually ran — which is the
 * thing a regex over the body cannot tell you.
 */
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

const fns = (
  await pool.query(`
  select p.proname as name,
         pg_get_function_identity_arguments(p.oid) as args,
         coalesce(array_length(p.proargtypes,1),0) as nargs,
         (select string_agg(format_type(t,null), ',')
            from unnest(p.proargtypes) as t) as argtypes
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.prokind='f' and p.prosecdef
     and has_function_privilege('authenticated', p.oid, 'EXECUTE')
   order by p.proname`)
).rows;

// A borrower: an active profile holding the `client` role and nothing else.
const authUser = (
  await pool.query(
    `insert into auth.users (email) values ('probe.borrower@test.invalid') returning id`,
  )
).rows[0];
const profile = (
  await pool.query(
    `insert into public.profiles (full_name, phone, auth_user_id, status)
     values ('Probe Borrower', '+256700999001', $1, 'active') returning id`,
    [authUser.id],
  )
).rows[0];
await pool.query(
  `insert into public.user_roles (profile_id, role_key) values ($1, 'client')`,
  [profile.id],
);
const borrower = { auth_user_id: authUser.id };

const results = [];
for (const fn of fns) {
  const casts =
    fn.nargs === 0
      ? ''
      : (fn.argtypes ?? '')
          .split(',')
          .map((t) => `null::${t}`)
          .join(', ');
  const client = await pool.connect();
  let verdict;
  let code = '';
  let message = '';
  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      borrower.auth_user_id,
    ]);
    await client.query('set local role authenticated');
    await client.query(`select public.${fn.name}(${casts})`);
    verdict = 'NO_REFUSAL';
  } catch (error) {
    code = error.code ?? '';
    message = (error.message ?? '').slice(0, 120);
    if (code === '42501') verdict = 'REFUSED_42501';
    else if (/not authorized|requires the|permission|capability|denied/i.test(message))
      verdict = 'REFUSED_MESSAGE';
    else verdict = `OTHER_${code}`;
  } finally {
    try {
      await client.query('rollback');
    } catch {}
    client.release();
  }
  results.push({ name: fn.name, args: fn.args, verdict, code, message });
}

const byVerdict = {};
for (const r of results) {
  const k = r.verdict.startsWith('OTHER') ? 'OTHER' : r.verdict;
  (byVerdict[k] ??= []).push(r);
}
console.log(`probed ${results.length} functions as a borrower\n`);
for (const [k, list] of Object.entries(byVerdict).sort()) {
  console.log(`${k}: ${list.length}`);
}
console.log('\n=== NO_REFUSAL (reached the body without any authorization check) ===');
for (const r of byVerdict.NO_REFUSAL ?? []) console.log(`  ${r.name}(${r.args})`);
console.log('\n=== OTHER (inconclusive: failed on something else first) ===');
for (const r of byVerdict.OTHER ?? [])
  console.log(`  ${r.name} [${r.code}] ${r.message}`);

// The fixture is removed so the probe leaves the database as it found it.
// `audit_log.actor_profile_id` references profiles with ON DELETE RESTRICT and
// audit rows are append-only, so the triggers come off exactly as
// tests/helpers/auth-fixtures.ts documents — safe only here, as the owner,
// against a throwaway database.
await pool.query('alter table public.audit_log disable trigger all');
await pool.query('delete from public.audit_log where actor_profile_id = $1', [
  profile.id,
]);
await pool.query('alter table public.audit_log enable trigger all');
await pool.query('delete from public.user_roles where profile_id = $1', [profile.id]);
await pool.query('delete from public.profiles where id = $1', [profile.id]);
await pool.query('delete from auth.users where id = $1', [authUser.id]);

await pool.end();
