/**
 * Polytos demonstration data.
 *
 *   npm run seed:demo
 *
 * Six members, their savings histories, a withdrawal that went all the way
 * through, a reversal, and one application still waiting on its consent — all
 * clearly synthetic, all written through the same functions the application
 * calls, and all safe to run twice.
 *
 * ===========================================================================
 * THE SAFEGUARDS
 * ===========================================================================
 *
 * This script writes money into a financial database. Every guard below is
 * there because the failure it prevents would be expensive and quiet.
 *
 * 1. **It refuses to run unless deliberately enabled.** `POLYTOS_SEED_DEMO`
 *    must be set to the exact phrase below. Not a truthy value, not `1`: a
 *    phrase somebody has to mean to type, so no CI job and no stray
 *    environment file can turn it on by accident.
 *
 * 2. **It targets only a recognised database, by allow-list.** The project
 *    reference is read out of the connection string and must match one this
 *    file names. A deny-list would be the wrong shape — it would have to
 *    anticipate every database that must not be touched, and the one it
 *    forgot would be the one that mattered. An allow-list refuses everything
 *    it does not recognise, which is the behaviour the brief asks for.
 *
 * 3. **It never resets anything.** There is no `drop`, no `truncate` and no
 *    `delete` in this file. Nothing is removed, so nothing that was not
 *    created by this script can be lost by running it.
 *
 * 4. **It touches no loan.** Not a contract, not a schedule, not a payment.
 *    The savings module and the loan book share a ledger and nothing else,
 *    and a demo seeder has no business in a repayment history.
 *
 * 5. **It is idempotent, by construction rather than by cleanup.** Every
 *    record is found before it is created, every posting carries a
 *    deterministic idempotency key derived from what it represents, and the
 *    posting functions return the movement that already exists. Running it
 *    ten times produces the same database as running it once — and a second
 *    run posts no money, which is the property that actually matters.
 *
 * 6. **It never supersedes a policy version the business put in force.** If a
 *    version is already active it uses that one. It publishes its own only
 *    when there is none, and labels it unmistakably.
 *
 * 7. **It is never part of a migration.** Migrations run on deploy; this does
 *    not run unless somebody types the command and the phrase.
 *
 * ===========================================================================
 */

import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import process from 'node:process';

import { config as loadDotenv } from 'dotenv';
import pg from 'pg';
import {
  chooseExistingDemoBorrowers,
  verifyBorrowerBridge,
  type DemoBorrower,
} from './demo-existing-borrowers';
import {
  ensureMemberLendingPolicy,
  memberLoanDemoRequested,
  MemberLoanDemoRefused,
  MEMBER_LOAN_ENABLE_PHRASE,
  seedMemberLoanScenarios,
  type MemberLoanTally,
} from './demo-member-loans';

// Mirror Next.js's precedence, so a developer's `.env.local` is what decides
// which database this talks to — the same file the application reads.
for (const file of ['.env.local', '.env']) {
  const path = join(process.cwd(), file);
  if (existsSync(path)) loadDotenv({ path, quiet: true });
}

// ---------------------------------------------------------------------------
// Safeguard 1: deliberate enablement
// ---------------------------------------------------------------------------

const ENABLE_PHRASE = 'yes-seed-polytos-demo-data';

// ---------------------------------------------------------------------------
// Safeguard 2: the allow-list
// ---------------------------------------------------------------------------

/**
 * The Supabase projects this script may write to, by project reference.
 *
 * One entry. The connection named `LENDING MANAGER`, project `lending
 * manager`, reference `fszgwemtgyrbhngajpzm`. Any other hosted project —
 * including the connection named `Primary`, whose reference is deliberately
 * not recorded anywhere in this repository — is refused, because it is not in
 * this list rather than because it was named.
 */
const ALLOWED_PROJECT_REFS: readonly string[] = ['fszgwemtgyrbhngajpzm'];

/**
 * Hosts that are a developer's own throwaway database.
 *
 * `scripts/pg-local.sh` builds one by applying the migrations to an empty
 * cluster, and the e2e harness uses the same thing. Neither holds anything
 * anybody would miss.
 */
const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1'];

interface Target {
  readonly kind: 'local' | 'supabase';
  readonly description: string;
}

/**
 * Work out what this connection string points at, or refuse.
 *
 * Supabase exposes two shapes and both carry the project reference: the direct
 * connection as `db.<ref>.supabase.co`, and the pooler as a username of
 * `postgres.<ref>`. Both are read, because a developer may have copied either
 * out of the dashboard and a script that understood only one would refuse a
 * legitimate target — or, worse, fail to recognise an illegitimate one.
 */
function identifyTarget(connectionString: string): Target {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(
      'DATABASE_URL is not a URL. Nothing can be verified about where it points, so nothing is written.',
    );
  }

  const host = url.hostname.toLowerCase();

  if (LOCAL_HOSTS.includes(host)) {
    return { kind: 'local', description: `a local database at ${host}:${url.port}` };
  }

  const fromHost = /^db\.([a-z0-9]{20})\.supabase\.(co|com|net)$/.exec(host);
  const fromUser = /^postgres\.([a-z0-9]{20})$/.exec(
    decodeURIComponent(url.username).toLowerCase(),
  );
  const ref = fromHost?.[1] ?? fromUser?.[1] ?? null;

  if (ref === null) {
    throw new Error(
      `Cannot work out which Supabase project ${host} belongs to. A target that cannot be identified is not written to.`,
    );
  }

  if (!ALLOWED_PROJECT_REFS.includes(ref)) {
    throw new Error(
      [
        `Project reference ${ref} is not on this script's allow-list.`,
        '',
        'This is the guard working, not a bug. Demonstration data is written to one',
        'named project and to local throwaway databases, and to nothing else. If this',
        'really is the right project, add its reference to ALLOWED_PROJECT_REFS in',
        'scripts/seed-demo.ts in a reviewed change — never by editing an environment',
        'variable.',
      ].join('\n'),
    );
  }

  return { kind: 'supabase', description: `Supabase project ${ref}` };
}

// ---------------------------------------------------------------------------
// Deterministic idempotency keys
// ---------------------------------------------------------------------------

/**
 * A stable uuid for one demonstration posting.
 *
 * Derived from a label describing what the posting *is* — "demo:fee:A",
 * "demo:deposit:A:3" — so the second run of this script arrives with the same
 * key as the first and the posting functions return the movement that already
 * exists. A random key per run would post the money again, which is the exact
 * failure the idempotency machinery exists to prevent, caused by the script
 * meant to demonstrate it.
 *
 * Namespaced with `polytos-demo` so no key here can collide with one minted
 * by the application.
 */
function demoKey(label: string): string {
  const hex = createHash('sha256').update(`polytos-demo:${label}`).digest('hex');
  // Shaped as a v4 uuid: the column is `uuid`, and a value that is not one
  // would be refused.
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

// ---------------------------------------------------------------------------
// The demonstration members
// ---------------------------------------------------------------------------

/**
 * Six members, each chosen to show one thing the module does.
 *
 * Every name carries the DEMO prefix, every phone number is inside the
 * reserved `+25670000xxxx` range, and every record is unmistakably synthetic.
 * Nothing here resembles a real person.
 *
 * `monthsBack` lists which months the member paid into, counted back from the
 * current one, and how much in each. The shapes are deliberate:
 *
 *   A — six unbroken qualifying months. Qualifies under either arm of the
 *       consecutive rule, so this is the member a Phase 3 loan can be
 *       demonstrated against.
 *   B — six qualifying months with a gap in the middle. Qualifies when the
 *       months need not be consecutive and does not when they must, which is
 *       the whole difference that undecided rule makes.
 *   C — three months in, on track. The ordinary case.
 *   D — this month short. The member a counter chases.
 *   E — saved, then withdrew. Carries the withdrawal that went through the
 *       full lifecycle: prepared, approved by somebody else, paid.
 *   F — paid the fee, no verified consent. Still `pending`, which is what the
 *       activation preconditions look like from the outside.
 */
interface DemoMember {
  readonly letter: string;
  readonly fullName: string;
  readonly phone: string;
  readonly sex: 'male' | 'female';
  readonly occupation: string;
  readonly villageArea: string;
  /** Months back from this one, and the deposits made in each. */
  readonly deposits: readonly {
    readonly monthsBack: number;
    readonly amounts: readonly number[];
  }[];
  /** Enrol and activate, or leave the application pending. */
  readonly activate: boolean;
}

const MEMBERS: readonly DemoMember[] = [
  {
    letter: 'A',
    fullName: 'DEMO Aisha Nakato',
    phone: '+256700000101',
    sex: 'female',
    occupation: 'Market trader',
    villageArea: 'Kalerwe',
    deposits: [6, 5, 4, 3, 2, 1].map((monthsBack) => ({
      monthsBack,
      amounts: [50_000],
    })),
    activate: true,
  },
  {
    letter: 'B',
    fullName: 'DEMO Joseph Okello',
    phone: '+256700000102',
    sex: 'male',
    occupation: 'Carpenter',
    villageArea: 'Bwaise',
    // Seven, six, five — then a missed month — then three, two, one. Six
    // qualifying months, longest unbroken run of three.
    deposits: [7, 6, 5, 3, 2, 1].map((monthsBack) => ({
      monthsBack,
      amounts: [50_000],
    })),
    activate: true,
  },
  {
    letter: 'C',
    fullName: 'DEMO Grace Atim',
    phone: '+256700000103',
    sex: 'female',
    occupation: 'Tailor',
    villageArea: 'Kawempe',
    // Three months, and this one met by two deposits rather than one — which
    // is how a member who cannot pay 50,000 at once still makes the month.
    deposits: [
      { monthsBack: 2, amounts: [50_000] },
      { monthsBack: 1, amounts: [30_000, 20_000] },
      { monthsBack: 0, amounts: [25_000, 25_000] },
    ],
    activate: true,
  },
  {
    letter: 'D',
    fullName: 'DEMO Samuel Mugisha',
    phone: '+256700000104',
    sex: 'male',
    occupation: 'Boda rider',
    villageArea: 'Kamwokya',
    deposits: [
      { monthsBack: 2, amounts: [50_000] },
      { monthsBack: 1, amounts: [50_000] },
      // Short of the minimum: the member a counter rings before month end.
      { monthsBack: 0, amounts: [20_000] },
    ],
    activate: true,
  },
  {
    letter: 'E',
    fullName: 'DEMO Rebecca Achieng',
    phone: '+256700000105',
    sex: 'female',
    occupation: 'Shopkeeper',
    villageArea: 'Ntinda',
    deposits: [
      { monthsBack: 3, amounts: [60_000] },
      { monthsBack: 2, amounts: [60_000] },
      { monthsBack: 1, amounts: [60_000] },
    ],
    activate: true,
  },
  {
    letter: 'F',
    fullName: 'DEMO Patrick Ssempa',
    phone: '+256700000106',
    sex: 'male',
    occupation: 'Welder',
    villageArea: 'Nakawa',
    // No deposits: there is no savings account, because the membership was
    // never activated.
    deposits: [],
    activate: false,
  },
];

/**
 * The version number the demonstration policy is published under.
 *
 * `membership_policy_version_shape` constrains the column to `N.N`, so the
 * word DEMO cannot go in the version itself. 999 is as far from a version the
 * business would ever publish as the format allows, and the title and the
 * notes say DEMONSTRATION ONLY in so many words — which is what a reader
 * actually sees on the policy screen.
 */
const DEMO_POLICY_VERSION = '999.0';

/** The staff account the demonstration acceptances are witnessed by. */
const DEMO_WITNESS = {
  fullName: 'DEMO Branch Witness',
  phone: '+256700000199',
} as const;

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

interface Tally {
  clientsCreated: number;
  membersEnrolled: number;
  depositsPosted: number;
  withdrawalsPaid: number;
  reversalsPosted: number;
  alreadyPresent: number;
}

async function main(): Promise<void> {
  // --- Safeguard 1 -------------------------------------------------------
  const enable = process.env.POLYTOS_SEED_DEMO ?? '';

  if (enable !== ENABLE_PHRASE) {
    console.error('Demonstration seeding is not enabled.\n');
    console.error('This script writes clients, memberships, fee receipts, savings');
    console.error('deposits and journal entries. It runs only when somebody means it:\n');
    console.error(`  POLYTOS_SEED_DEMO=${ENABLE_PHRASE} npm run seed:demo\n`);
    console.error('Polytos Phase 3 member loan scenarios need a second phrase, and run');
    console.error('only against a local throwaway database — they publish a policy');
    console.error('version answering three decisions the client has not made:\n');
    console.error(
      `  POLYTOS_SEED_DEMO=${ENABLE_PHRASE} \\\n` +
        `  POLYTOS_SEED_MEMBER_LOANS=${MEMBER_LOAN_ENABLE_PHRASE} npm run seed:demo\n`,
    );
    console.error('Nothing has been written.');
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL?.trim() ?? '';

  if (connectionString === '') {
    console.error('DATABASE_URL is not set, so there is nothing to connect to.');
    console.error('For a local throwaway database: npm run db:local:setup');
    process.exit(1);
  }

  // --- Safeguard 2 -------------------------------------------------------
  let target: Target;
  try {
    target = identifyTarget(connectionString);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('\nNothing has been written.');
    process.exit(1);
  }

  console.log(`Seeding Polytos demonstration data into ${target.description}.`);
  if (target.kind === 'supabase') {
    console.log(
      'This is a hosted project. Existing records are read, never reset — see the\n' +
        'safeguards at the top of scripts/seed-demo.ts.',
    );
  }
  console.log('');

  const client = new pg.Client({ connectionString });
  await client.connect();

  let memberLoanTally: MemberLoanTally | null = null;

  const tally: Tally = {
    clientsCreated: 0,
    membersEnrolled: 0,
    depositsPosted: 0,
    withdrawalsPaid: 0,
    reversalsPosted: 0,
    alreadyPresent: 0,
  };

  try {
    // Preflight every assignment before any policy, member or money write.
    const borrowers = await chooseExistingDemoBorrowers(
      client,
      MEMBERS,
      process.env.POLYTOS_DEMO_BORROWER_REUSE,
    );
    // --- Polytos Phase 3: member lending, local only --------------------
    //
    // Its own phrase, because it publishes a policy version answering three
    // decisions the client has not made — and refused on any hosted target,
    // because putting those figures in front of a reader there would present
    // them as the programme's terms. Decided *before* the policy, because the
    // member-lending version has to be the demonstration's only version: see
    // the head of scripts/demo-member-loans.ts for why the two cannot coexist.
    const memberLoans = memberLoanDemoRequested(process.env.POLYTOS_SEED_MEMBER_LOANS);

    if (memberLoans && target.kind !== 'local') {
      console.error(
        'Member loan demonstration data is refused on a hosted database.\n\n' +
          'It publishes a policy version answering the interest basis, the interest\n' +
          'method and the savings-to-loan multiplier — three decisions the client has\n' +
          'not made. Those figures must not appear on a hosted project as though they\n' +
          "were the programme's terms.\n\n" +
          'Nothing has been written.',
      );
      process.exit(1);
    }

    let policyId: string;

    try {
      policyId = memberLoans
        ? await ensureMemberLendingPolicy(client)
        : await ensurePolicy(client);
    } catch (error) {
      // A refusal here is guidance, not a fault: it says which database this
      // mode needs and why, so a stack trace would bury the one useful line.
      if (error instanceof MemberLoanDemoRefused) {
        console.error('');
        console.error('Member loan demonstration data is refused on this database.');
        console.error('');
        console.error(error.message);
        console.error('');
        console.error('Nothing has been written.');
        process.exit(1);
      }
      throw error;
    }

    const witness = await ensureWitness(client, target);
    const approver = await ensureApprover(client, target);

    for (const member of MEMBERS) {
      await seedMember(client, member, {
        policyId,
        witness,
        approver,
        tally,
        existingBorrower: borrowers.get(member.letter),
      });
    }

    await reconcile(client);
    await verifyBorrowerBridge(client, MEMBERS, borrowers);

    if (memberLoans) {
      console.log('');
      console.log('Member loan scenarios (TEST ONLY policy, isolated database):');

      // The Owner, for disbursement and collection. A Manager holds
      // `loans:approve` and deliberately not `loans:disburse`, so one profile
      // cannot originate, approve and pay out a loan — and a demonstration
      // using one profile for both would render that separation as though it
      // were not there.
      const owner = await ensureStaffProfile(client, target, {
        fullName: 'DEMO Branch Owner',
        phone: '+256700000197',
        role: 'owner_admin',
        label: 'owner',
      });

      memberLoanTally = await seedMemberLoanScenarios(client, {
        approver,
        disburser: owner,
      });
    }
  } finally {
    await client.end();
  }

  console.log('');
  console.log('Done.');
  console.log(`  clients created      ${String(tally.clientsCreated)}`);
  console.log(`  members enrolled     ${String(tally.membersEnrolled)}`);
  console.log(`  deposits posted      ${String(tally.depositsPosted)}`);
  console.log(`  withdrawals paid     ${String(tally.withdrawalsPaid)}`);
  console.log(`  reversals posted     ${String(tally.reversalsPosted)}`);
  console.log(`  already present      ${String(tally.alreadyPresent)}`);

  if (memberLoanTally !== null) {
    console.log('');
    console.log(
      '  member loan applications opened   ' + String(memberLoanTally.applicationsOpened),
    );
    console.log(
      '  member loans approved             ' + String(memberLoanTally.loansApproved),
    );
    console.log(
      '  member loans disbursed            ' + String(memberLoanTally.loansDisbursed),
    );
    console.log(
      '  collections posted                ' + String(memberLoanTally.paymentsPosted),
    );
    console.log(
      '  approvals refused, as intended    ' + String(memberLoanTally.approvalsRefused),
    );
    console.log(
      '  member loans already present      ' + String(memberLoanTally.alreadyPresent),
    );
  }

  if (
    tally.clientsCreated === 0 &&
    tally.membersEnrolled === 0 &&
    tally.depositsPosted === 0
  ) {
    console.log('');
    console.log('Nothing new was written — the demonstration data was already there.');
  }
}

/**
 * The policy version the demonstration members are held to.
 *
 * Uses the version already in force where there is one, whatever its figures,
 * because superseding a version the business approved is not a seeder's
 * decision to make. Publishes a clearly-labelled DEMO version only when there
 * is none at all, which is the state a fresh database is in.
 */
async function ensurePolicy(client: pg.Client): Promise<string> {
  const active = await client.query<{ id: string; version: string }>(
    `select id, version from public.membership_policy_versions where status = 'active'`,
  );

  if (active.rows.length > 0) {
    const row = active.rows[0]!;
    console.log(`  policy          version ${row.version} is already in force; using it`);
    return row.id;
  }

  const existing = await client.query<{ id: string }>(
    `select id from public.membership_policy_versions where version = $1`,
    [DEMO_POLICY_VERSION],
  );

  if (existing.rows.length > 0) {
    console.log(
      `  policy          version ${DEMO_POLICY_VERSION} exists but is not in force; using it`,
    );
    return existing.rows[0]!.id;
  }

  // Every one of the nine open questions is answered here, and each answer is
  // a *demonstration* figure rather than a recommendation. The DEMO prefix and
  // the title say so, so nobody can mistake this row for the client's own
  // decisions.
  const created = await client.query<{ id: string }>(
    `insert into public.membership_policy_versions
       (version, title, effective_from, status, approved_at, approved_by_label,
        registration_fee, monthly_savings_minimum, savings_qualifying_months,
        member_loan_interest_rate_bps, member_loan_max_term_months,
        member_loan_weekly_cadence_max_months, non_member_loan_max_term_months,
        medical_benefit_rate_bps, medical_benefit_min_admission_days,
        family_condolence_benefit, member_bereavement_benefit,
        qualifying_months_consecutive, savings_withdrawal_with_active_loan,
        notes)
     values
       ($1,
        'DEMONSTRATION ONLY — not the approved Polytos membership policy',
        (public.business_date() - 400), 'active',
        pg_catalog.now(), 'DEMO seeder',
        5000, 50000, 6,
        500, 5, 2, 3,
        500, 1, 100000, 200000,
        false, 'allowed',
        'Published by scripts/seed-demo.ts so the savings module can be demonstrated. Every figure is illustrative. The nine policy questions the client has not answered are answered here with placeholder values and must not be read as decisions.')
     returning id`,
    [DEMO_POLICY_VERSION],
  );

  console.log(
    `  policy          published version ${DEMO_POLICY_VERSION} (no version was in force)`,
  );
  return created.rows[0]!.id;
}

/**
 * The staff profile the demonstration acceptances name as witness.
 *
 * A real, active profile is required: the acceptance guard checks it exists
 * and is active for *every* caller, including this one, which is the point of
 * the check. It carries no `auth_user_id`, so it is not an account anybody can
 * sign in to.
 */
async function ensureWitness(client: pg.Client, target: Target): Promise<StaffProfile> {
  return ensureStaffProfile(client, target, {
    fullName: DEMO_WITNESS.fullName,
    phone: DEMO_WITNESS.phone,
    role: 'secretary_treasurer',
    label: 'witness',
  });
}

interface StaffProfile {
  readonly profileId: string;
  /**
   * The auth subject to impersonate as, or `null` on the trusted path.
   *
   * Present only where creating one is safe — see `ensureStaffProfile`.
   */
  readonly authUserId: string | null;
}

/**
 * A demonstration staff profile, and where it is safe to do so, a session to
 * act as.
 *
 * ## Why a session at all
 *
 * `decide_savings_withdrawal` refuses a decision from whoever prepared the
 * request, by comparing `requested_by` to `current_profile_id()`. On the
 * trusted path both are null, so the comparison has nothing to compare and the
 * demonstration would show a withdrawal prepared and approved by `system` —
 * which is precisely the thing the control exists to prevent, rendered as
 * though the control were not there.
 *
 * So where an `auth.users` row can be created, the seeder acts as two
 * different people and the separation in the demonstration data is real.
 *
 * ## Why only on a local database
 *
 * `auth.users` belongs to Supabase's own auth service. Writing to it directly
 * on a hosted project puts a row in a table whose shape and invariants another
 * system owns, for the sake of a label on a demonstration screen. Not worth
 * it: on a hosted project the seeder takes the trusted path and *says* that
 * the labels read `system`, rather than quietly producing data that overstates
 * what it proves.
 */
async function ensureStaffProfile(
  client: pg.Client,
  target: Target,
  spec: {
    readonly fullName: string;
    readonly phone: string;
    readonly role: string;
    readonly label: string;
  },
): Promise<StaffProfile> {
  const existing = await client.query<{ id: string; auth_user_id: string | null }>(
    `select id, auth_user_id from public.profiles where phone = $1`,
    [spec.phone],
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0]!;
    return { profileId: row.id, authUserId: row.auth_user_id };
  }

  let authUserId: string | null = null;

  if (target.kind === 'local') {
    const authUser = await client.query<{ id: string }>(
      `insert into auth.users (email) values ($1) returning id`,
      [`demo.${spec.role}@polytos.test`],
    );
    authUserId = authUser.rows[0]!.id;
  }

  const created = await client.query<{ id: string }>(
    `insert into public.profiles (full_name, phone, status, auth_user_id)
     values ($1, $2, 'active', $3) returning id`,
    [spec.fullName, spec.phone, authUserId],
  );

  await client.query(
    `insert into public.user_roles (profile_id, role_key) values ($1, $2)
     on conflict do nothing`,
    [created.rows[0]!.id, spec.role],
  );

  console.log(`  ${spec.label.padEnd(15)} created the DEMO ${spec.label} profile`);
  return { profileId: created.rows[0]!.id, authUserId };
}

/**
 * A second staff profile, so a withdrawal can be decided by somebody other
 * than whoever prepared it.
 *
 * Needed because `decide_savings_withdrawal` refuses a decision from the
 * requester. Here it costs one extra row; in the business it is the control
 * that stops one person taking money out of a member's savings alone.
 */
async function ensureApprover(client: pg.Client, target: Target): Promise<StaffProfile> {
  return ensureStaffProfile(client, target, {
    fullName: 'DEMO Branch Manager',
    phone: '+256700000198',
    role: 'manager',
    label: 'approver',
  });
}

/** The first day of the month `back` months before the business date. */
function monthStart(today: string, back: number): string {
  const [year, month] = today.split('-').map(Number) as [number, number];
  const shifted = new Date(Date.UTC(year, month - 1 - back, 1));
  return shifted.toISOString().slice(0, 10);
}

async function seedMember(
  client: pg.Client,
  member: DemoMember,
  context: {
    readonly policyId: string;
    readonly witness: StaffProfile;
    readonly approver: StaffProfile;
    readonly tally: Tally;
    readonly existingBorrower?: DemoBorrower;
  },
): Promise<void> {
  const { tally } = context;
  const displayName = context.existingBorrower?.full_name ?? member.fullName;

  // --- The client record -------------------------------------------------
  const found = context.existingBorrower
    ? null
    : await client.query<{ id: string }>(
        `select id from public.clients where phone = $1`,
        [member.phone],
      );

  let clientId: string;

  if (context.existingBorrower) {
    clientId = context.existingBorrower.id;
  } else if (found && found.rows.length > 0) {
    clientId = found.rows[0]!.id;
  } else {
    const created = await client.query<{ id: string }>(
      `insert into public.clients
         (full_name, sex, date_of_birth, phone, occupation, village_area, district,
          notes)
       values ($1, $2, '1990-01-01', $3, $4, $5, 'Kampala',
               'DEMONSTRATION RECORD created by scripts/seed-demo.ts. Not a real person.')
       returning id`,
      [member.fullName, member.sex, member.phone, member.occupation, member.villageArea],
    );
    clientId = created.rows[0]!.id;
    tally.clientsCreated += 1;
  }

  // Store the demo tag ONLY on the membership; never rewrite borrower identity.
  //
  // The prefix up to and including the letter is load-bearing: a later run
  // recovers the scenario-to-borrower mapping by reading it back out of these
  // notes, so `chooseExistingDemoBorrowers` slices the letter from a fixed
  // offset. Anything added below has to come after it.
  const scenarioNote =
    'DEMONSTRATION SCENARIO ' +
    member.letter +
    ' — ' +
    (context.existingBorrower ? 'existing loan borrower' : 'synthetic demo client');

  // --- The membership ----------------------------------------------------
  const liveMembership = await client.query<{ id: string; status: string }>(
    `select id, status from public.memberships
      where client_id = $1 and status in ('pending', 'active', 'suspended')`,
    [clientId],
  );

  let membershipId: string;

  if (liveMembership.rows.length > 0) {
    membershipId = liveMembership.rows[0]!.id;
    tally.alreadyPresent += 1;
  } else if (member.activate) {
    // Through `enrol_member`, the same function the enrolment screen calls —
    // so the demonstration data cannot drift into a state the product cannot
    // produce. The key is derived from the member's letter, so a second run
    // replays rather than enrolling again.
    const enrolled = await client.query<{ id: string }>(
      `select public.enrol_member(
                $1, 'cash', null, 'witnessed_in_branch', $2, $3::uuid,
                null, $4::uuid, null, null, null, null,
                $5) as id`,
      [
        clientId,
        displayName,
        demoKey(`fee:${member.letter}`),
        context.witness.profileId,
        scenarioNote,
      ],
    );
    membershipId = enrolled.rows[0]!.id;
    tally.membersEnrolled += 1;
  } else {
    // Member F: the application is taken and the fee is paid, but no consent
    // is recorded — so the membership stays `pending`, which is what the
    // ADR-050 activation preconditions look like from the outside. This is
    // the state the membership record's "before this can be activated" panel
    // exists to explain.
    const created = await client.query<{ id: string }>(
      `insert into public.memberships (client_id, applied_on, policy_version_id, notes)
       values ($1, (public.business_date() - 10), $2, $3)
       returning id`,
      [
        clientId,
        context.policyId,
        // The scenario marker has to lead, because the mapping is recovered
        // from a fixed offset. The explanation this screen exists to show is
        // kept after it rather than dropped for the marker's sake.
        scenarioNote +
          '. DEMONSTRATION application. The fee is paid and no verified acceptance ' +
          'has been taken, so it cannot be activated.',
      ],
    );
    membershipId = created.rows[0]!.id;

    await client.query(
      `select public.record_membership_fee(
                $1,
                (select v.registration_fee
                   from public.membership_policy_versions v
                   join public.memberships m on m.policy_version_id = v.id
                  where m.id = $1),
                'cash', null, $2::uuid, 'DEMONSTRATION fee')`,
      [membershipId, demoKey(`fee:${member.letter}`)],
    );
    tally.membersEnrolled += 1;
  }

  if (member.deposits.length === 0) {
    console.log(`  member ${member.letter}        ${displayName} — application pending`);
    return;
  }

  // --- The savings account ----------------------------------------------
  const account = await client.query<{ id: string }>(
    `select id from public.savings_accounts where membership_id = $1`,
    [membershipId],
  );

  if (account.rows.length === 0) {
    console.log(
      `  member ${member.letter}        ${displayName} — no savings account; skipping deposits`,
    );
    return;
  }

  const savingsAccountId = account.rows[0]!.id;

  // --- The deposits ------------------------------------------------------
  const today = await client.query<{ d: string }>(
    `select pg_catalog.to_char(public.business_date(), 'YYYY-MM-DD') as d`,
  );
  const businessToday = today.rows[0]!.d;

  let posted = 0;

  for (const month of member.deposits) {
    for (const [index, amount] of month.amounts.entries()) {
      const key = demoKey(
        `deposit:${member.letter}:${String(month.monthsBack)}:${String(index)}`,
      );

      // Already there? The posting function would replay, which is correct —
      // but asking first keeps the tally honest about what this run did.
      const already = await client.query(
        `select 1 from public.savings_transactions where idempotency_key = $1`,
        [key],
      );

      if (already.rows.length > 0) {
        tally.alreadyPresent += 1;
        continue;
      }

      // The deposit is dated inside its month. `app.business_now` is honoured
      // only for a direct owner session — no application path can set it — so
      // this is the one place a dated history can be built without any date
      // column being writable.
      const valueDate = monthStart(businessToday, month.monthsBack);
      const day = month.monthsBack === 0 ? businessToday : `${valueDate.slice(0, 8)}12`;

      await client.query('begin');
      try {
        await client.query(`select set_config('app.business_now', $1, true)`, [
          `${day}T09:00:00Z`,
        ]);
        await client.query(
          `select public.post_savings_deposit($1, $2, 'cash', null, $3::uuid,
                                              'DEMONSTRATION deposit')`,
          [savingsAccountId, amount, key],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }

      posted += 1;
      tally.depositsPosted += 1;
    }
  }

  // --- Member E's withdrawal, and the reversal -------------------------
  if (member.letter === 'E') {
    await seedWithdrawal(client, {
      savingsAccountId,
      preparer: context.witness,
      decider: context.approver,
      tally,
    });
    await seedReversal(client, { savingsAccountId, tally });
  }

  const balance = await client.query<{ balance: string }>(
    `select balance from public.member_savings_balances where savings_account_id = $1`,
    [savingsAccountId],
  );

  console.log(
    `  member ${member.letter}        ${displayName} — ` +
      `${String(posted)} new deposit${posted === 1 ? '' : 's'}, ` +
      `balance UGX ${Number(balance.rows[0]?.balance ?? 0).toLocaleString('en-UG')}`,
  );
}

/**
 * One withdrawal, through the whole lifecycle.
 *
 * Prepared by one member of staff and decided by another, because
 * `decide_savings_withdrawal` refuses a decision from the requester. Doing it
 * properly here is the point: a seeder that bypassed the control would
 * demonstrate a system that does not have one.
 *
 * Idempotent on the request as well as on the payment: a second run finds the
 * paid request and does nothing.
 */
async function seedWithdrawal(
  client: pg.Client,
  context: {
    readonly savingsAccountId: string;
    readonly preparer: StaffProfile;
    readonly decider: StaffProfile;
    readonly tally: Tally;
  },
): Promise<void> {
  const existing = await client.query(
    `select 1 from public.savings_withdrawal_requests
      where savings_account_id = $1 and reason like 'DEMONSTRATION%'`,
    [context.savingsAccountId],
  );

  if (existing.rows.length > 0) {
    context.tally.alreadyPresent += 1;
    return;
  }

  // Prepared by one person and decided by another, as two real sessions where
  // the seeder has them — so `requested_by` and `decided_by` are two
  // different profiles and the refusal in
  // `decide_savings_withdrawal` is a control the demonstration data actually
  // went through, rather than one it bypassed.
  //
  // Where there are no sessions to act as (a hosted project — see
  // `ensureStaffProfile`), both land on the trusted path and both labels read
  // `system`. That is said out loud below rather than papered over.
  const requestId = await asStaff(client, context.preparer, async (run) => {
    const result = await run(
      `select public.request_savings_withdrawal(
                  $1, 40000, 'DEMONSTRATION withdrawal — school fees') as id`,
      [context.savingsAccountId],
    );
    return (result.rows[0] as { id: string }).id;
  });

  await asStaff(client, context.decider, async (run) => {
    await run(
      `select public.decide_savings_withdrawal($1, true, 'DEMONSTRATION approval')`,
      [requestId],
    );
    await run(`select public.post_savings_withdrawal($1, 'cash', null, $2::uuid)`, [
      requestId,
      demoKey('withdrawal:E'),
    ]);
  });

  if (context.preparer.authUserId === null) {
    console.log(
      '  withdrawal      prepared and decided on the trusted path, so both labels',
    );
    console.log(
      '                  read "system". The control is in the database either way.',
    );
  }

  context.tally.withdrawalsPaid += 1;
}

/**
 * Run statements as one member of staff, committed.
 *
 * `set local role authenticated` plus the JWT subject is exactly what
 * PostgREST does for a browser request, so everything these statements touch
 * goes through Row Level Security and through each posting function's own
 * capability check as that person. A seeder that wrote around those checks
 * would produce data the product could not have produced.
 *
 * Falls through to the trusted path when there is no session to act as.
 */
async function asStaff<T>(
  client: pg.Client,
  staff: StaffProfile,
  run: (
    exec: (sql: string, params?: readonly unknown[]) => Promise<pg.QueryResult>,
  ) => Promise<T>,
): Promise<T> {
  const exec = async (
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<pg.QueryResult> => client.query(sql, [...params]);

  if (staff.authUserId === null) return run(exec);

  await client.query('begin');
  try {
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      staff.authUserId,
    ]);
    await client.query('set local role authenticated');
    const result = await run(exec);
    // Back to the owner before committing, so the connection is not left in a
    // restricted role for whatever runs next.
    await client.query('reset role');
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

/**
 * One reversed deposit, so the demonstration shows what a correction looks
 * like.
 *
 * A reversal is a contra row with its own contra journal, never an edit — so
 * the original deposit stays in the statement and the correction sits beside
 * it naming the reason. This is the behaviour a member asks about when their
 * statement shows a figure twice.
 */
async function seedReversal(
  client: pg.Client,
  context: { readonly savingsAccountId: string; readonly tally: Tally },
): Promise<void> {
  const already = await client.query(
    `select 1 from public.savings_transactions
      where savings_account_id = $1 and kind = 'deposit_reversal'`,
    [context.savingsAccountId],
  );

  if (already.rows.length > 0) {
    context.tally.alreadyPresent += 1;
    return;
  }

  // An extra deposit, then its reversal, so the reversal does not take a
  // qualifying month away from the member's history and make the demonstration
  // confusing.
  const key = demoKey('deposit:E:reversed');

  const existingDeposit = await client.query<{ id: string }>(
    `select id from public.savings_transactions where idempotency_key = $1`,
    [key],
  );

  const depositId =
    existingDeposit.rows.length > 0
      ? existingDeposit.rows[0]!.id
      : (
          await client.query<{ id: string }>(
            `select public.post_savings_deposit($1, 15000, 'cash', null, $2::uuid,
                                                'DEMONSTRATION deposit, recorded twice in error') as id`,
            [context.savingsAccountId, key],
          )
        ).rows[0]!.id;

  await client.query(
    `select public.reverse_savings_transaction(
              $1, 'DEMONSTRATION reversal — the same deposit was recorded twice')`,
    [depositId],
  );

  context.tally.reversalsPosted += 1;
}

/**
 * The invariant, checked rather than asserted.
 *
 * The savings subledger and the `2100 Member Savings` ledger account must
 * agree, always. If seeding broke that, the seeder says so loudly rather than
 * leaving a database whose trial balance is wrong and whose demonstration
 * looks fine.
 */
async function reconcile(client: pg.Client): Promise<void> {
  const result = await client.query<{ subledger: string; ledger: string }>(
    `select
       (select coalesce(sum(signed_amount), 0)::bigint
          from public.savings_transactions)::text as subledger,
       (select balance from public.ledger_account_balances where code = '2100')::text
         as ledger`,
  );

  const row = result.rows[0]!;
  const subledger = BigInt(row.subledger);
  const ledger = BigInt(row.ledger ?? '0');

  console.log('');
  console.log(
    `  reconciliation  subledger UGX ${subledger.toLocaleString('en-UG')}, ` +
      `ledger 2100 UGX ${ledger.toLocaleString('en-UG')}`,
  );

  if (subledger !== ledger) {
    throw new Error(
      `The savings subledger (${subledger.toString()}) and the 2100 Member Savings ledger balance (${ledger.toString()}) disagree. This is a defect, not a seeding problem — report it.`,
    );
  }

  console.log('                  they agree.');
}

main().catch((error: unknown) => {
  console.error('');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
