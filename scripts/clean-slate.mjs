/**
 * Empty the books, keep the system. The runner.
 *
 *   node scripts/clean-slate.mjs --owner <profile-id>
 *     Dry run. Reports what it would remove and what it would keep.
 *     This is the default, and the only thing it does without the phrase.
 *
 *   POLYTOS_CLEAN_SLATE=yes-empty-this-database \
 *     node scripts/clean-slate.mjs --owner <profile-id> --execute
 *     Does it, in one transaction, then verifies the result.
 *
 * ## Refusals
 *
 * It refuses a hosted database unless `--i-have-a-dump <path>` names a file
 * that exists. That is the whole backup requirement on a free plan: a logical
 * `pg_dump` costs nothing, and it is the only route back, because this
 * procedure is irreversible by design.
 *
 * It refuses if `DATABASE_URL` looks like the hosted project and the phrase
 * is absent; if the Owner profile does not exist, is not active, or does not
 * hold `owner_admin`; and if any table in the database is classified in
 * neither the keep nor the empty list.
 *
 * ## After it runs
 *
 * It re-reads the database and asserts the end state rather than trusting the
 * statements: no business rows, the debits and credits both zero, the
 * reference data still present, the Owner still able to work, and no orphan
 * left behind by a nulled reference.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

import {
  countBusinessRows,
  projectRefFromConnectionString,
  RESET_SEQUENCES,
  runCleanSlate,
} from './lib/clean-slate.mjs';

const require = createRequire(import.meta.url);
const pg = require('pg');

const ENABLE_PHRASE = 'yes-empty-this-database';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const execute = process.argv.includes('--execute');
const ownerProfileId = arg('owner');
const dumpPath = arg('i-have-a-dump');
const connectionString = process.env.DATABASE_URL;

if (connectionString === undefined || connectionString === '') {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

if (ownerProfileId === undefined) {
  console.error(
    'Pass --owner <profile-id>: the cleanup must be told which profile to keep.\n' +
      "  select id, full_name from public.profiles where status = 'active';",
  );
  process.exit(1);
}

// A hosted connection is not a disposable one.
const looksHosted =
  /supabase\.(co|com)|pooler\.supabase/.test(connectionString) &&
  !/localhost|127\.0\.0\.1/.test(connectionString);

const expectedProject = arg('expect-project');
const actualProject = projectRefFromConnectionString(connectionString);

if (execute) {
  // The phrase says "empty a database". It does not say WHICH database, and
  // a DATABASE_URL is one paste away from naming somebody else's project. So
  // the target is confirmed by name before anything is emptied: the caller
  // states the project it means, and the connection string has to agree.
  if (expectedProject !== undefined) {
    if (actualProject === null) {
      console.error(
        `Refusing to empty: --expect-project ${expectedProject} was given, but no\n` +
          'Supabase project reference could be read from DATABASE_URL. The target\n' +
          'identity cannot be confirmed, so it is not assumed.',
      );
      process.exit(1);
    }
    if (actualProject !== expectedProject.toLowerCase()) {
      console.error(
        'Refusing to empty: DATABASE_URL does not point at the expected project.\n\n' +
          `  --expect-project  ${expectedProject.toLowerCase()}\n` +
          `  DATABASE_URL      ${actualProject}\n\n` +
          'This is the wrong database. Nothing was changed.',
      );
      process.exit(1);
    }
  } else if (looksHosted) {
    console.error(
      'Refusing to empty a hosted database without confirming which one.\n\n' +
        `  --expect-project ${actualProject ?? '<project-ref>'}\n\n` +
        'Pass the project reference this cleanup is authorised for. The phrase\n' +
        'authorises emptying a database; this names the database.',
    );
    process.exit(1);
  }

  if (process.env.POLYTOS_CLEAN_SLATE !== ENABLE_PHRASE) {
    console.error(
      `Refusing to empty a database without the phrase.\n\n  POLYTOS_CLEAN_SLATE=${ENABLE_PHRASE} \\\n    node scripts/clean-slate.mjs --owner ${ownerProfileId} --execute\n`,
    );
    process.exit(1);
  }
  if (looksHosted && (dumpPath === undefined || !existsSync(dumpPath))) {
    console.error(
      'Refusing to empty a hosted database without a dump.\n\n' +
        '  pg_dump "$DATABASE_URL" -Fc -f polytos-preclean-$(date -u +%Y%m%dT%H%M%SZ).dump\n' +
        '  sha256sum polytos-preclean-*.dump\n\n' +
        'Then pass --i-have-a-dump <that file>. This procedure cannot be undone;\n' +
        'the dump is the only way back.',
    );
    process.exit(1);
  }
}

const pool = new pg.Pool({ connectionString, max: 1 });
const db = { query: (sql, params) => pool.query(sql, params) };

function table(label, figures) {
  console.log(`\n  ${label}`);
  for (const [key, value] of Object.entries(figures)) {
    console.log(`    ${key.padEnd(20)} ${String(value).padStart(12)}`);
  }
}

try {
  const result = await runCleanSlate(db, { ownerProfileId, dryRun: !execute });

  console.log(
    `\nPOLYTOS clean slate — ${execute ? 'EXECUTED' : 'DRY RUN (nothing was changed)'}`,
  );
  console.log(
    `  owner kept: ${String(result.owner.full_name)} (${String(result.owner.roles)})`,
  );
  console.log(`  hosted connection: ${looksHosted ? 'yes' : 'no'}`);

  table('before', result.before);

  if (!execute) {
    console.log(
      `\n  Would empty ${result.plan.truncate} business tables, deactivate and` +
        '\n  unlink every non-Owner profile, delete their Auth users, remove' +
        '\n  every stored document, and reset the client, loan and payment' +
        '\n  counters. Reference data, settings, schema and migrations are' +
        '\n  untouched. The audit log and any approved policy version cannot' +
        '\n  be removed and are left in place \u2014 see the note after an' +
        '\n  --execute run.' +
        `\n\n  To do it: POLYTOS_CLEAN_SLATE=${ENABLE_PHRASE} ... --execute\n`,
    );
    process.exit(0);
  }

  table('after', result.after);

  // --- verify, rather than trust -----------------------------------------
  const a = result.after;
  const problems = [];

  const mustBeZero = [
    'clients',
    'loans',
    'payments',
    'journal_entries',
    'journal_lines',
    'memberships',
    'savings_accounts',
    'guarantors',
    'storage_objects',
    'total_debits',
    'total_credits',
  ];
  for (const key of mustBeZero) {
    if (a[key] !== 0) problems.push(`${key} is ${String(a[key])}, expected 0`);
  }

  // Exactly one profile can still work. Others may remain as audit actors,
  // deactivated and unlinked — the audit log forbids deleting them.
  if (a.active_profiles !== 1) {
    problems.push(`active profiles is ${String(a.active_profiles)}, expected 1`);
  }
  // Exactly one, not "at most one". Zero would mean the Owner cannot sign in
  // either, which is a failed cleanup wearing the look of a thorough one.
  if (a.auth_users !== 1) {
    problems.push(`auth_users is ${String(a.auth_users)}, expected exactly 1`);
  }

  const mustSurvive = [
    'roles',
    'permissions',
    'ledger_accounts',
    'cadences',
    'loan_products',
  ];
  for (const key of mustSurvive) {
    if (a[key] === 0) problems.push(`${key} is empty — reference data was lost`);
  }

  // The Owner must still hold owner_admin and be active.
  const { rows: ownerAfter } = await db.query(
    `select p.status, p.auth_user_id,
            (select pg_catalog.string_agg(ur.role_key, ',')
               from public.user_roles ur where ur.profile_id = p.id) as roles
       from public.profiles p where p.id = $1`,
    [ownerProfileId],
  );
  if (ownerAfter[0]?.status !== 'active') problems.push('the Owner is no longer active');
  if (!String(ownerAfter[0]?.roles ?? '').includes('owner_admin')) {
    problems.push('the Owner no longer holds owner_admin');
  }
  // Active and privileged still gets nobody in without a credential, and the
  // one Auth user left has to be this profile's rather than merely somebody's.
  if (ownerAfter[0]?.auth_user_id === null || ownerAfter[0]?.auth_user_id === undefined) {
    problems.push('the Owner is no longer linked to an Auth user');
  } else {
    const { rows: survivors } = await db.query(
      'select id from auth.users where id = $1',
      [ownerAfter[0].auth_user_id],
    );
    if (survivors.length !== 1) {
      problems.push("the Owner's Auth user was deleted");
    }
  }

  // No preserved row may still point at a profile that is gone.
  const { rows: orphans } = await db.query(`
    select 'company_settings' as t, count(*) as n from public.company_settings
      where updated_by is not null and updated_by not in (select id from public.profiles)
    union all select 'business_settings', count(*) from public.business_settings
      where updated_by is not null and updated_by not in (select id from public.profiles)
    union all select 'finance_settings', count(*) from public.finance_settings
      where updated_by is not null and updated_by not in (select id from public.profiles)
  `);
  for (const row of orphans) {
    if (Number(row.n) > 0) problems.push(`${String(row.t)} holds an orphaned updated_by`);
  }

  // The counters start again.
  const { rows: counters } = await db.query(
    `select scope, last_value from public.reference_sequences
      where scope = any ($1::text[]) order by scope`,
    [RESET_SEQUENCES],
  );
  for (const row of counters) {
    if (Number(row.last_value) !== 0) {
      problems.push(
        `the ${String(row.scope)} counter is at ${String(row.last_value)}, expected 0`,
      );
    }
  }

  if (problems.length > 0) {
    console.error('\n  VERIFICATION FAILED');
    for (const problem of problems) console.error(`    - ${problem}`);
    process.exit(1);
  }

  console.log(
    '\n  verified: no business rows, debits and credits both zero, reference' +
      '\n  data intact, exactly one active profile holding owner_admin, one' +
      '\n  Auth user, no orphaned references, counters reset.',
  );
  // Not a failure of this procedure — retiring a policy is launch item A-1 —
  // but a clean slate that still has a DEMONSTRATION ONLY policy governing
  // membership is not ready for a client, so it is said loudly rather than
  // left in a figure nobody reads.
  const residue = result.residue ?? {};
  if (Number(residue.active_demonstration_policies ?? 0) > 0) {
    console.log(
      '\n  ACTION REQUIRED: a DEMONSTRATION ONLY policy version is still' +
        '\n  active. A real member could be enrolled under demonstration' +
        '\n  terms. This procedure does not change it: an approved version is' +
        '\n  immutable by design and DELETE is rejected outright. Retire it' +
        '\n  as launch item A-1, or start a fresh Supabase project.',
    );
  } else if (Number(a.active_policies ?? 0) > 0) {
    console.log(
      `\n  NOTE: ${String(a.active_policies)} policy version(s) remain active. Confirm that is` +
        '\n  intended before the first real member is enrolled.',
    );
  }

  if (a.audit_entries > 0) {
    console.log(
      `\n  NOTE: ${String(a.audit_entries)} audit entries remain, and ${String(a.profiles - 1)} deactivated` +
        '\n  profile(s) with them. The audit log is append-only by design —' +
        '\n  UPDATE, DELETE and TRUNCATE all raise — and it references those' +
        '\n  profiles ON DELETE RESTRICT, so neither can be removed in place.' +
        '\n  They can no longer sign in or hold any capability. For a database' +
        '\n  with no demonstration history at all, start a fresh Supabase' +
        '\n  project and apply the migrations to it; that is free.\n',
    );
  } else {
    console.log('');
  }
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
} finally {
  await pool.end();
}
