/**
 * The database security gate.
 *
 * ## What this is for
 *
 * Almost every privileged object in this schema is safe because of a decision
 * somebody made once: this function checks a capability, that view projects
 * only published columns, this grant was deliberately withheld. Those
 * decisions are invisible at the point where they get undone. A new
 * `SECURITY DEFINER` function with no guard, a `GRANT` restated too widely
 * after a `create or replace`, a view that loses its `security_invoker`
 * setting — none of it fails a test that is about something else, and none of
 * it looks wrong in a diff.
 *
 * So this gate does not try to judge whether a function is safe. It compares
 * the live privileged surface against a reviewed baseline and fails when they
 * differ. Widening the surface is then a deliberate act: the baseline entry
 * has to be written, with a classification and a reason, and that shows up in
 * review as a security change rather than as an incidental line in a
 * migration.
 *
 * ## Why not detect unguarded functions by reading their bodies
 *
 * Because it does not work, and worse, it looks like it works. A body can
 * mention `user_has_permission` in a comment, call it and discard the result,
 * check the wrong capability, or check the right one on a path the interesting
 * input never takes. Any regex over the source says "guarded" to all four. The
 * brief is explicit about this, so helper-name presence is reported here as
 * advisory context only — it is printed, it never decides anything, and it
 * never turns a finding green.
 *
 * What decides is the baseline, reviewed by a human, plus the invariant checks
 * below, which assert structural facts rather than inferring intent.
 *
 *   node scripts/check-database-security.mjs
 *   node scripts/check-database-security.mjs --update   (rewrite the baseline)
 *
 * `--update` is for after a reviewed change. It prints the diff it is about to
 * write, so an unintended widening is still visible in the commit.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import pg from 'pg';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASELINE_PATH = path.join(ROOT, 'config', 'database-security-baseline.json');
const EXPOSED_ROLES = ['anon', 'authenticated'];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. This gate needs a migrated database.');
  process.exit(2);
}

const update = process.argv.includes('--update');

/**
 * The baseline, read once so the invariants can honour reviewed exemptions.
 *
 * An empty object if it cannot be parsed: a missing or broken baseline must
 * make the gate louder, never quieter.
 */
let baselineForInvoker = {};
try {
  baselineForInvoker = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
} catch {
  baselineForInvoker = {};
}
const findings = [];
const advisory = [];

function fail(check, detail) {
  findings.push({ check, detail });
}

// ---------------------------------------------------------------------------
// The live surface
// ---------------------------------------------------------------------------

/**
 * Every SECURITY DEFINER function an exposed role may execute.
 *
 * `has_function_privilege` is the right instrument rather than parsing
 * `proacl`: it resolves membership and the PUBLIC pseudo-role, so a function
 * reachable only because PUBLIC holds the default EXECUTE is reported here
 * exactly like an explicit grant. That is the case a hand-read of the ACL
 * misses, because the ACL is null.
 */
const DEFINER_FUNCTIONS_SQL = `
  select p.proname                                        as name,
         pg_get_function_identity_arguments(p.oid)        as args,
         has_function_privilege('anon',          p.oid, 'EXECUTE') as anon,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
         (p.proacl is null)                               as public_default_acl,
         (pg_get_functiondef(p.oid) ~
            '(require_business_identity|require_savings_account_access|user_has_permission|current_profile_id|auth\\.uid\\(\\))'
         )                                                as mentions_a_guard_helper
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.prosecdef
     and (has_function_privilege('anon',          p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
   order by p.proname, args`;

/**
 * Views that read with the definer's privileges, and what exposed roles may do
 * with them.
 *
 * A view is definer-mode when `security_invoker` is off *or absent* — absent
 * is the PostgreSQL default, so a view created without the setting is a
 * definer view that mentions nothing about being one. The write privileges
 * matter as much as SELECT: a simple single-table view is auto-updatable, so a
 * definer view with a write grant is a path around the base table's RLS.
 */
const DEFINER_VIEWS_SQL = `
  select c.relname as name,
         coalesce(
           (select option_value
              from pg_options_to_table(c.reloptions)
             where option_name = 'security_invoker'), 'absent') as security_invoker,
         (select coalesce(string_agg(distinct g.privilege_type, ',' order by g.privilege_type), '')
            from information_schema.role_table_grants g
           where g.table_schema = 'public'
             and g.table_name = c.relname
             and g.grantee = 'anon')          as anon_privileges,
         (select coalesce(string_agg(distinct g.privilege_type, ',' order by g.privilege_type), '')
            from information_schema.role_table_grants g
           where g.table_schema = 'public'
             and g.table_name = c.relname
             and g.grantee = 'authenticated')  as authenticated_privileges,
         (select coalesce(string_agg(distinct g.privilege_type, ',' order by g.privilege_type), '')
            from information_schema.role_table_grants g
           where g.table_schema = 'public'
             and g.table_name = c.relname
             and g.grantee = 'PUBLIC')         as public_privileges
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'v'
     and coalesce(
           (select option_value
              from pg_options_to_table(c.reloptions)
             where option_name = 'security_invoker'), 'false') not in ('true','on')
   order by c.relname`;

const pool = new pg.Pool({ connectionString, max: 2 });

async function rows(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

// ---------------------------------------------------------------------------
// Invariants: structural facts, asserted directly rather than inferred.
// ---------------------------------------------------------------------------
async function checkInvariants() {
  // 1. No function anywhere may rely on PUBLIC's default EXECUTE. A null ACL
  //    means every role, including anon, inherits EXECUTE — and it is the
  //    shape a `create function` without an explicit revoke leaves behind.
  const nullAcl = await rows(`
    select p.proname, p.prosecdef
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f' and p.proacl is null
     order by p.proname`);
  if (nullAcl.length > 0) {
    fail(
      'public-default-execute',
      `${nullAcl.length} function(s) leave EXECUTE to PUBLIC by default ` +
        `(no explicit grant/revoke): ${nullAcl.map((r) => r.proname).join(', ')}. ` +
        `Add an explicit REVOKE ... FROM public and grant only the roles that need it.`,
    );
  }

  // 2. Row Level Security on every public table. A table without it is not
  //    protected by any policy, however many policies its neighbours have.
  const noRls = await rows(`
    select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
     order by c.relname`);
  if (noRls.length > 0) {
    fail(
      'rls-disabled',
      `${noRls.length} public table(s) have RLS disabled: ` +
        `${noRls.map((r) => r.relname).join(', ')}.`,
    );
  }

  // 3. Every function pins its search_path. An unpinned SECURITY DEFINER
  //    function can be made to resolve a name against a schema the caller
  //    controls.
  const unpinned = await rows(`
    select p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and (p.proconfig is null
            or not exists (select 1 from unnest(p.proconfig) c
                            where c like 'search\\_path=%'))
     order by p.proname`);
  if (unpinned.length > 0) {
    fail(
      'search-path-unpinned',
      `${unpinned.length} function(s) do not pin search_path: ` +
        `${unpinned.map((r) => r.proname).join(', ')}.`,
    );
  }

  // 4. The loan approval rules must stay behind the internal name that the
  //    Data API cannot reach (20261106000100). A later `create or replace` of
  //    the public name with the full body would restore the disclosure while
  //    leaving every behavioural test passing, because the wrapper's own
  //    checks would still be there — in front of a second copy of the rules.
  const split = await rows(`
    select p.proname,
           (pg_get_functiondef(p.oid) ~ 'member_amount_above_ceiling') as holds_rules,
           has_function_privilege('authenticated', p.oid, 'EXECUTE')   as authenticated
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'validate_loan_for_approval%'
     order by p.proname`);
  const wrapper = split.find((r) => r.proname === 'validate_loan_for_approval');
  const internal = split.find((r) => r.proname === 'validate_loan_for_approval_internal');
  if (!wrapper || !internal) {
    fail(
      'loan-validation-split',
      'expected both validate_loan_for_approval and ' +
        'validate_loan_for_approval_internal to exist (see 20261106000100)',
    );
  } else {
    if (wrapper.holds_rules) {
      fail(
        'loan-validation-split',
        'the public validate_loan_for_approval now holds the approval rules; ' +
          'the rules belong behind validate_loan_for_approval_internal',
      );
    }
    if (!internal.holds_rules) {
      fail(
        'loan-validation-split',
        'validate_loan_for_approval_internal no longer holds the approval rules',
      );
    }
    if (internal.authenticated) {
      fail(
        'loan-validation-split',
        'validate_loan_for_approval_internal is executable by authenticated, ' +
          'which puts the unguarded approval assessment back on the Data API',
      );
    }
  }

  // 5. `company_identity` is a reviewed definer view (20261106000300). It is
  //    auto-updatable and runs as its owner, so the SELECT-only grant is the
  //    entire control over writes reaching company_settings around the
  //    settings:update capability.
  const identity = await rows(`
    select coalesce(string_agg(distinct g.privilege_type, ',' order by g.privilege_type), '')
             as privileges
      from information_schema.role_table_grants g
     where g.table_schema = 'public' and g.table_name = 'company_identity'
       and g.grantee in ('anon', 'authenticated', 'PUBLIC')`);
  const identityPrivileges = identity[0]?.privileges ?? '';
  if (identityPrivileges !== 'SELECT') {
    fail(
      'company-identity-grant',
      `exposed roles hold "${identityPrivileges}" on public.company_identity; ` +
        `expected exactly "SELECT". A write grant on this auto-updatable ` +
        `definer view would bypass company_settings RLS.`,
    );
  }

  // 6. Every function an exposed role needs because something runs in *its*
  //    context must actually be executable by that role.
  //
  //    This is the check Phase 2 did not have, and its absence cost 31 browser
  //    failures. `20261106000400` withdrew a grant from
  //    `savings_account_governing_policy` after confirming that no view, no RLS
  //    policy, no CHECK constraint and no application route named it. All four
  //    answers were correct and all four were the wrong question: two SECURITY
  //    INVOKER functions call it, one of which the application calls by name,
  //    and an invoker function executes with the privileges of whoever called
  //    it. So the session needed EXECUTE in its own right, and every savings
  //    screen died on `permission denied for function`.
  //
  //    A SECURITY DEFINER hop ends the chain, because it runs as its owner. So
  //    the dependency closure to worry about is the one reachable through
  //    invoker functions only, and that is what this walks.
  //
  //    This is the one place the gate matches text against function bodies, and
  //    the direction matters: PL/pgSQL bodies create no catalog dependencies, so
  //    there is nothing else to read. Over-matching here produces a *failure* a
  //    human resolves, never a pass — the opposite of inferring safety from a
  //    helper's name, which is why that remains advisory.
  for (const role of EXPOSED_ROLES) {
    const reachable = await rows(
      `
      -- MATERIALIZED, and pg_get_functiondef applied only here: it raises on an
      -- aggregate, and without this fence the planner is free to evaluate it
      -- before the prokind filter.
      with recursive pub as materialized (
        select p.oid, p.proname, p.prosecdef,
               pg_get_functiondef(p.oid) as def,
               has_function_privilege($1, p.oid, 'EXECUTE') as callable
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prokind = 'f'
      ),
      recursive_seed as (
        select oid, proname, def from pub where not prosecdef and callable
      ),
      closure as (
        select oid, proname, def from recursive_seed
        union
        -- Invoker functions reached from an invoker function still run as the
        -- caller, so the chain continues. A definer hop is absent here on
        -- purpose: it runs as its owner and ends the chain.
        select q.oid, q.proname, q.def
          from closure c
          join pub q on not q.prosecdef and q.oid <> c.oid
         where c.def ~ ('\\m' || q.proname || '\\M[[:space:]]*\\(')
      )
      select distinct t.proname as needs, c.proname as reached_from
        from closure c
        join pub t on t.oid <> c.oid and not t.callable
       where c.def ~ ('\\m' || t.proname || '\\M[[:space:]]*\\(')
       order by t.proname`,
      [role],
    );

    for (const row of reachable) {
      // A reviewed exemption: a dependency that exists in the body but cannot
      // be reached by this role, with the reason recorded in the baseline.
      // Keyed on all three of role, caller and target, so widening any one of
      // them is a new finding rather than a silent pass.
      const exempt = (baselineForInvoker.invoker_chain_exemptions ?? []).find(
        (e) => e.role === role && e.caller === row.reached_from && e.needs === row.needs,
      );
      if (exempt?.reason) continue;

      fail(
        'invoker-chain-broken',
        `${role} may execute public.${row.reached_from}, which is SECURITY ` +
          `INVOKER and references public.${row.needs} — but ${role} cannot ` +
          `execute ${row.needs}. An invoker function runs with the caller's ` +
          `privileges, so that call fails at runtime with "permission denied ` +
          `for function". Either grant EXECUTE on ${row.needs} to ${role} and ` +
          `record it in the baseline, or make ${row.reached_from} SECURITY ` +
          `DEFINER so the chain ends before it.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Baseline comparison
// ---------------------------------------------------------------------------
function keyOfFunction(row) {
  return `${row.name}(${row.args})`;
}

function surfaceOfFunction(row) {
  return {
    anon: row.anon,
    authenticated: row.authenticated,
    public_default_acl: row.public_default_acl,
  };
}

function surfaceOfView(row) {
  return {
    security_invoker: row.security_invoker,
    anon_privileges: row.anon_privileges,
    authenticated_privileges: row.authenticated_privileges,
    public_privileges: row.public_privileges,
  };
}

function compare(kind, live, baseline, describe) {
  const liveKeys = Object.keys(live).sort();
  const baseKeys = Object.keys(baseline).sort();

  for (const key of liveKeys) {
    if (!(key in baseline)) {
      fail(
        `${kind}-unreviewed`,
        `NEW ${describe}: ${key} — ${JSON.stringify(live[key])}. ` +
          `Nothing has reviewed this exposure. Either withhold the grant, or ` +
          `add it to ${path.relative(ROOT, BASELINE_PATH)} with a ` +
          `classification and a reason, in the same pull request.`,
      );
      continue;
    }
    const before = JSON.stringify(baseline[key].surface);
    const after = JSON.stringify(live[key]);
    if (before !== after) {
      fail(
        `${kind}-widened`,
        `CHANGED ${describe}: ${key}\n      reviewed: ${before}\n      live:     ${after}`,
      );
    }
  }

  for (const key of baseKeys) {
    if (!(key in live)) {
      // Shrinking is the goal, so this is not a failure — but the baseline
      // must not keep claiming an exception that no longer exists, or the
      // exception list stops being a list of real exceptions.
      fail(
        `${kind}-stale-baseline`,
        `${describe} ${key} is in the reviewed baseline but no longer exposed. ` +
          `Good — remove the entry (\`--update\`) so the list keeps shrinking.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
async function main() {
  const functionRows = await rows(DEFINER_FUNCTIONS_SQL);
  const viewRows = await rows(DEFINER_VIEWS_SQL);

  const liveFunctions = Object.fromEntries(
    functionRows.map((r) => [keyOfFunction(r), surfaceOfFunction(r)]),
  );
  const liveViews = Object.fromEntries(viewRows.map((r) => [r.name, surfaceOfView(r)]));

  for (const row of functionRows) {
    if (!row.mentions_a_guard_helper) {
      advisory.push(
        `${keyOfFunction(row)} references no authorization helper. Advisory ` +
          `only — presence of one would not have proved anything either.`,
      );
    }
  }

  await checkInvariants();

  if (update) {
    const previous = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    const carry = (prev, key) =>
      prev[key] ?? { classification: 'REVIEW ME', reason: 'REVIEW ME' };
    const next = {
      $comment: previous.$comment,
      // Carried forward, never regenerated: these are human judgements about
      // dependencies that exist but cannot be reached, and --update must not
      // quietly drop one.
      invoker_chain_exemptions: previous.invoker_chain_exemptions ?? [],
      functions: Object.fromEntries(
        Object.entries(liveFunctions).map(([key, surface]) => {
          const prior = carry(previous.functions ?? {}, key);
          return [
            key,
            {
              classification: prior.classification,
              reason: prior.reason,
              surface,
            },
          ];
        }),
      ),
      views: Object.fromEntries(
        Object.entries(liveViews).map(([key, surface]) => {
          const prior = carry(previous.views ?? {}, key);
          return [
            key,
            {
              classification: prior.classification,
              reason: prior.reason,
              surface,
            },
          ];
        }),
      ),
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `Baseline rewritten: ${Object.keys(next.functions).length} function(s), ` +
        `${Object.keys(next.views).length} definer view(s).`,
    );
    console.log(
      'Any entry marked "REVIEW ME" must be classified and justified before merge.',
    );
    await pool.end();
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  compare(
    'definer-function',
    liveFunctions,
    baseline.functions ?? {},
    'SECURITY DEFINER function reachable by an exposed role',
  );
  compare('definer-view', liveViews, baseline.views ?? {}, 'SECURITY DEFINER view');

  for (const [key, entry] of Object.entries({
    ...(baseline.functions ?? {}),
    ...(baseline.views ?? {}),
  })) {
    if (
      !entry.classification ||
      !entry.reason ||
      entry.classification === 'REVIEW ME' ||
      entry.reason === 'REVIEW ME'
    ) {
      fail(
        'baseline-unjustified',
        `${key} is in the baseline without a classification and reason.`,
      );
    }
  }

  console.log('Database security gate');
  console.log(
    `  SECURITY DEFINER functions reachable by ${EXPOSED_ROLES.join('/')}: ` +
      `${Object.keys(liveFunctions).length}`,
  );
  console.log(`  SECURITY DEFINER views: ${Object.keys(liveViews).length}`);
  if (advisory.length > 0) {
    console.log(`\n  Advisory (never a failure, never a pass):`);
    for (const note of advisory) console.log(`    - ${note}`);
  }

  if (findings.length > 0) {
    console.error(`\n${findings.length} finding(s):\n`);
    for (const { check, detail } of findings) {
      console.error(`  [${check}] ${detail}`);
    }
    console.error(
      `\nIf a change here is intended, review it, then run ` +
        `\`node scripts/check-database-security.mjs --update\` and commit the ` +
        `baseline with a classification and a reason for every entry.`,
    );
    await pool.end();
    process.exit(1);
  }

  console.log('\n  No unreviewed privileged exposure.');
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(2);
});
