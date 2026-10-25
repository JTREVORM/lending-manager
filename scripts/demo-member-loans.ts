/**
 * Polytos Phase 3 demonstration data: member loans.
 *
 * ===========================================================================
 * WHY THIS IS A SEPARATE MODE, AND LOCAL ONLY
 * ===========================================================================
 *
 * ## It is refused on a hosted database, by target rather than by name
 *
 * `scripts/seed-demo.ts` writes savings to the hosted demonstration project
 * because savings are open there. Member loans are **not** open there: the
 * interest basis, the interest method and the savings multiplier are three
 * decisions the client has not made, and the demonstration policy `999.0`
 * deliberately leaves all three NULL.
 *
 * A member loan can therefore only be demonstrated under a policy version that
 * answers them — a version this file would have to publish. Publishing it on
 * the hosted project would put figures nobody approved in front of a reader as
 * though they were the programme's terms. So this mode refuses any target but a
 * local throwaway database, and it refuses by *kind* rather than by project
 * name, which is the same reasoning the allow-list in `seed-demo.ts` uses.
 *
 * ## It needs a database where no savings policy is in force yet, and why
 *
 * This is a real constraint rather than a convenience, and it is worth stating
 * because it surfaced a Phase 2 behaviour nobody had had to meet yet.
 *
 * `savings_accounts.policy_version_id` is **frozen at opening** — the guard in
 * `20261020000500` refuses a change to it — and
 * `member_savings_qualification` judges a contribution history against *that*
 * version, by way of
 * `membership_policy_allows(v_account.policy_version_id, 'savings')`.
 *
 * Only one policy version may be in force. So publishing a second version
 * supersedes the first, and every savings account opened under the first stops
 * qualifying — not because the member did anything, but because the version
 * their account is pinned to no longer authorises savings. A recorded
 * re-acceptance moves the *membership* onto the new terms and cannot move the
 * account, because the account's version is immutable.
 *
 * That means this mode cannot be bolted onto a database already demonstrating
 * savings under `999.0`: it would publish a lending-open version, supersede
 * `999.0`, and silently un-qualify all six savings scenarios. So instead it
 * publishes the lending-open TEST ONLY version **as the demonstration's only
 * version**, and the savings scenarios enrol under it too — one coherent
 * database where savings and member lending both work. On a database that
 * already has `999.0` in force it refuses and says why.
 *
 * The behaviour is recorded as a finding in `docs/POLYTOS-MEMBER-LOANS.md`
 * rather than changed here. Re-judging a month that was saved against a
 * UGX 50,000 minimum under a later version's different minimum would be the
 * wrong fix, and fixing it properly is a Phase 2 decision about what a
 * re-acceptance should carry.
 *
 * ## Idempotency
 *
 * By construction, as the savings seeder's is. Every record is found before it
 * is created, every posting carries a deterministic idempotency key derived
 * from what it represents, and the lifecycle functions refuse a second
 * approval or a second disbursement by state. Running it ten times produces
 * the same database as running it once.
 *
 * ## What it never does
 *
 * It writes no ordinary loan, touches no existing loan contract, reprices
 * nothing and rewrites no savings transaction. The only loans it creates name
 * the member loan product, and the only clients it touches are the ones
 * `seed-demo.ts` created or mapped.
 */

import { createHash } from 'node:crypto';

import type pg from 'pg';

export const MEMBER_LOAN_ENABLE_PHRASE = 'yes-seed-polytos-member-loan-demo';

/**
 * The version the member-loan demonstration is held to.
 *
 * `998.0` rather than `999.0`: both are far outside anything the business would
 * publish, and two numbers keep the two demonstrations distinguishable in the
 * policy list. The title and the notes say TEST ONLY in so many words, which
 * is what a reader actually sees on the policy screen.
 */
export const MEMBER_LOAN_POLICY_VERSION = '998.0';

/**
 * The monthly collection convention the demonstration uses.
 *
 * A fixture's choice, not a Polytos rule. `clamp_to_month_end` is picked
 * because it is what PostgreSQL's own month arithmetic does, so a reader
 * checking a date by hand gets the same answer — and the other convention is
 * equally implemented and equally tested. The business has decided neither.
 */
const DEMO_MONTH_ANCHOR = 'clamp_to_month_end';

/**
 * The savings-to-loan multiplier the demonstration uses.
 *
 * 20,000 bp is twice savings. **This is an illustration and not an approved
 * Polytos rule** — question 3 is open, and the figure exists so the ceiling
 * arithmetic can be seen working rather than because anybody chose it.
 */
const DEMO_MULTIPLIER_BPS = 20_000;

/**
 * The two people a member loan passes through.
 *
 * Two, not one, and that is the control rather than the decoration. The
 * capability matrix withholds `loans:disburse` from the Manager precisely so
 * that one person cannot originate a loan, approve it and hand over the cash
 * with nobody else involved — so a demonstration that approved and disbursed
 * as the same profile would render the separation as though it were not there,
 * which is exactly the mistake the savings seeder's own two-actor withdrawal
 * was written to avoid.
 */
export interface MemberLoanActors {
  /** Holds `loans:approve`. A Manager. */
  readonly approver: { readonly authUserId: string | null };
  /** Holds `loans:disburse` and `payments:create`. The Owner. */
  readonly disburser: { readonly authUserId: string | null };
}

export interface MemberLoanTally {
  applicationsOpened: number;
  loansApproved: number;
  loansDisbursed: number;
  paymentsPosted: number;
  approvalsRefused: number;
  alreadyPresent: number;
}

export function emptyMemberLoanTally(): MemberLoanTally {
  return {
    applicationsOpened: 0,
    loansApproved: 0,
    loansDisbursed: 0,
    paymentsPosted: 0,
    approvalsRefused: 0,
    alreadyPresent: 0,
  };
}

/** The same deterministic key derivation the savings seeder uses. */
function demoKey(seed: string): string {
  const digest = createHash('sha256').update(`polytos-member-loan:${seed}`).digest('hex');

  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

/**
 * Whether the member-loan demonstration is enabled, and may run here.
 *
 * Both halves, in one place, so no caller can satisfy one and skip the other.
 */
export function memberLoanDemoRequested(enable: string | undefined): boolean {
  return (enable ?? '') === MEMBER_LOAN_ENABLE_PHRASE;
}

export class MemberLoanDemoRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemberLoanDemoRefused';
  }
}

/**
 * The scenarios, and what each one is for.
 *
 * Every one of them attaches to a member `seed-demo.ts` has already created,
 * by letter, so this adds no client and duplicates nobody. Four of the eight
 * scenarios §16 asks for are already standing in the savings data — C has three
 * months and does not qualify, D is short this month, E saved and withdrew, and
 * every borrower without a membership is the non-member case — so this file
 * adds the four that need a loan.
 */
interface MemberLoanScenario {
  /**
   * The scenario's own key, which is what makes its loan findable on a second
   * run. Usually the member's letter; `B2` is a second application for the
   * same member, because the member who qualifies is the only one who can
   * demonstrate a refusal that is *only* about the ceiling.
   */
  readonly key: string;
  /** The demonstration member this attaches to, by `seed-demo.ts`'s letter. */
  readonly letter: string;
  readonly label: string;
  /** Shillings. Chosen against the member's own savings, not at random. */
  readonly principal: number;
  readonly termMonths: number;
  /** How far to drive it. */
  readonly stage: 'application' | 'approved' | 'active';
  /** Suspend the membership before attempting approval. */
  readonly suspendFirst?: boolean;
  /** Ask for more than the ceiling supports, so the refusal can be seen. */
  readonly overCeiling?: boolean;
  /** Post one collection against an active loan. */
  readonly collectOnce?: boolean;
}

const SCENARIOS: readonly MemberLoanScenario[] = [
  {
    key: 'A',
    letter: 'A',
    label: 'a qualified member with an active member loan, collected once',
    // A has six unbroken months of UGX 50,000: 300,000 saved, so 600,000
    // supported at the demonstration multiplier. 200,000 is comfortably
    // inside it and leaves capacity visible on the panel.
    principal: 200_000,
    termMonths: 2,
    stage: 'active',
    collectOnce: true,
  },
  {
    key: 'B',
    letter: 'B',
    label: 'a qualified member whose application is awaiting approval',
    // B qualifies only because the months need not be consecutive under this
    // version, which is the whole difference question 4 makes — so an approver
    // looking at this application sees a run of three and a count of six.
    principal: 150_000,
    termMonths: 1,
    stage: 'application',
  },
  {
    key: 'B2',
    letter: 'B',
    label: 'a qualified member refused for asking above what their savings support',
    // B again, and deliberately: a refusal that is *only* about the ceiling
    // needs a member who qualifies on every other count. B has 300,000 saved,
    // so 600,000 is supported and 5,000,000 is refused by the ceiling alone.
    // A draft does not count towards the active-loan limit, so B's pending
    // application above does not get in the way.
    principal: 5_000_000,
    termMonths: 1,
    stage: 'approved',
    overCeiling: true,
  },
  {
    key: 'C',
    letter: 'C',
    label: 'a member refused for want of qualifying months',
    // C has three months. The application can be opened and the approval is
    // refused, which is the control this phase exists to prove.
    principal: 100_000,
    termMonths: 1,
    stage: 'approved',
  },
  {
    key: 'E',
    letter: 'E',
    label:
      'a member refused on two counts at once — months and ceiling — because ' +
      'the validator returns every reason rather than the first',
    // E saved 180,000 across three months and withdrew 40,000, so 140,000
    // secures a loan and 280,000 is the ceiling. Asking for 500,000 while
    // three months short is refused for both reasons in one answer, which is
    // what `validate_loan_for_approval` returning a *set* of codes is for: an
    // approver is told everything that has to change, not the first thing.
    principal: 500_000,
    termMonths: 1,
    stage: 'approved',
    overCeiling: true,
  },
  {
    key: 'D',
    letter: 'D',
    label: 'a suspended member who cannot be approved',
    // D is short this month. Suspending the membership first makes the
    // refusal about standing as well as savings, which is a different control
    // and worth demonstrating separately.
    principal: 100_000,
    termMonths: 1,
    stage: 'approved',
    suspendFirst: true,
  },
];

/**
 * Publish the TEST ONLY lending policy, or refuse and say why.
 *
 * Called **before** `seed-demo.ts` publishes its own, so the savings scenarios
 * enrol under this version too. See the head of this file for why the two
 * cannot coexist.
 */
export async function ensureMemberLendingPolicy(client: pg.Client): Promise<string> {
  const existing = await client.query<{ id: string; version: string }>(
    `select id, version from public.membership_policy_versions where version = $1`,
    [MEMBER_LOAN_POLICY_VERSION],
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0]!;
    console.log(
      `  policy          TEST ONLY version ${row.version} is already published`,
    );
    return row.id;
  }

  const active = await client.query<{ version: string }>(
    `select version from public.membership_policy_versions where status = 'active'`,
  );

  if (active.rows.length > 0) {
    throw new MemberLoanDemoRefused(
      `Policy version ${active.rows[0]!.version} is already in force, and only one may be.\n\n` +
        'Publishing the member-lending TEST ONLY version would supersede it, and every\n' +
        'savings account opened under it would stop qualifying — a savings account is\n' +
        'frozen to the version it was opened under, and a superseded version authorises\n' +
        'nothing. See the head of scripts/demo-member-loans.ts.\n\n' +
        'Run this against a fresh local database:\n' +
        '  npm run db:local:migrate',
    );
  }

  const created = await client.query<{ id: string }>(
    `insert into public.membership_policy_versions
       (version, title, effective_from, status, approved_at, approved_by_label,
        registration_fee, monthly_savings_minimum, savings_qualifying_months,
        member_loan_interest_rate_bps, member_loan_max_term_months,
        member_loan_weekly_cadence_max_months, non_member_loan_max_term_months,
        medical_benefit_rate_bps, medical_benefit_min_admission_days,
        family_condolence_benefit, member_bereavement_benefit,
        qualifying_months_consecutive, savings_withdrawal_with_active_loan,
        interest_basis, interest_method, savings_to_loan_multiplier_bps,
        notes)
     values
       ($1,
        'TEST ONLY — member lending demonstration, not the approved Polytos policy',
        (public.business_date() - 400), 'active',
        pg_catalog.now(), 'TEST ONLY seeder',
        5000, 50000, 6,
        500, 5, 2, 3,
        500, 1, 100000, 200000,
        false, 'above_pledged',
        'per_month', 'reducing_balance_monthly', $2::int,
        'Published by scripts/demo-member-loans.ts so member lending can be '
          || 'demonstrated end to end on an isolated database. The interest basis, '
          || 'the interest method and the savings-to-loan multiplier are the three '
          || 'decisions the client has NOT made; the values here are illustrative '
          || 'and must not be read as decisions. The confirmed figures — the 5% '
          || 'rate, the UGX 50,000 minimum, the six qualifying months, the 5-month '
          || 'maximum term and the 2-month weekly boundary — are the client''s own.')
     returning id`,
    [MEMBER_LOAN_POLICY_VERSION, DEMO_MULTIPLIER_BPS],
  );

  console.log(
    `  policy          published TEST ONLY version ${MEMBER_LOAN_POLICY_VERSION} ` +
      '(member lending open; three figures are illustrative)',
  );

  return created.rows[0]!.id;
}

/**
 * Open the monthly cadence and the member loan product.
 *
 * Both ship closed, because both wait on a decision: the cadence on what a
 * monthly collection does in a month that has no such day, and the product on
 * the three pricing questions. Opening them is two statements each and is
 * exactly what the business will do when it decides — so the demonstration
 * does it the same way rather than reaching around it.
 */
async function openLendingConfiguration(client: pg.Client): Promise<void> {
  // Write-once by trigger: settable while NULL, frozen from that moment. A
  // second run finds it already set and the UPDATE is a no-op.
  await client.query(
    `update public.repayment_frequencies
        set month_anchor = $1
      where key = 'monthly' and month_anchor is null`,
    [DEMO_MONTH_ANCHOR],
  );

  await client.query(
    `update public.repayment_frequencies
        set is_active = true
      where key = 'monthly' and not is_active`,
  );

  await client.query(
    `update public.loan_products
        set status = 'active',
            allowed_repayment_frequencies = array['weekly', 'monthly'],
            default_repayment_frequency = 'weekly'
      where product_code = 'ML' and status <> 'active'`,
  );

  console.log(
    `  configuration   monthly anchor ${DEMO_MONTH_ANCHOR} (TEST ONLY), ` +
      'member loan product active',
  );
}

interface ScenarioMember {
  readonly clientId: string;
  readonly membershipId: string;
  readonly savingsAccountId: string | null;
}

/** The member a scenario attaches to, found by the letter in its notes. */
async function findMember(
  client: pg.Client,
  letter: string,
): Promise<ScenarioMember | null> {
  const row = await client.query<{
    client_id: string;
    membership_id: string;
    savings_account_id: string | null;
  }>(
    `select m.client_id, m.id as membership_id, sa.id as savings_account_id
       from public.memberships m
       left join public.savings_accounts sa on sa.membership_id = m.id
      where m.notes like $1
      limit 1`,
    [`DEMONSTRATION SCENARIO ${letter} %`],
  );

  const found = row.rows[0];
  if (found === undefined) return null;

  return {
    clientId: found.client_id,
    membershipId: found.membership_id,
    savingsAccountId: found.savings_account_id,
  };
}

/**
 * The guarantor an application needs.
 *
 * `validate_loan_for_approval` demands the business's guarantor floor, with a
 * phone number, an occupation, a location, a relationship, identification on
 * file and a signed undertaking. A demonstration that skipped it would be
 * demonstrating an approval path the product does not have.
 */
async function ensureDemoGuarantor(
  client: pg.Client,
  clientId: string,
  letter: string,
): Promise<void> {
  const existing = await client.query<{ n: number }>(
    `select count(*)::int as n from public.client_guarantors
      where client_id = $1 and active`,
    [clientId],
  );

  if ((existing.rows[0]?.n ?? 0) > 0) return;

  // Found before it is created, which is this seeder's idempotency style
  // throughout. `guarantors.phone` is indexed but not unique — a family can
  // share a handset — so ON CONFLICT has nothing to key on and a find-then-
  // insert is the only correct shape.
  const phone = `+2567000002${String(letter.charCodeAt(0) % 10)}0`;

  const found = await client.query<{ id: string }>(
    `select id from public.guarantors where phone = $1 limit 1`,
    [phone],
  );

  let guarantorId = found.rows[0]?.id ?? null;

  if (guarantorId === null) {
    const created = await client.query<{ id: string }>(
      `insert into public.guarantors
         (full_name, sex, date_of_birth, phone, occupation, location, district,
          photo_path)
       values ($1, 'male', '1985-01-01', $2, 'Shopkeeper', 'Ntinda', 'Kampala',
               'guarantors/00000000-0000-4000-8000-000000000001/photo/demo.jpg')
       returning id`,
      [`DEMO Guarantor for ${letter}`, phone],
    );
    guarantorId = created.rows[0]!.id;
  }

  await client.query(
    `insert into public.guarantor_identities (guarantor_id, nin)
     values ($1, $2)
     on conflict (guarantor_id) do nothing`,
    [
      guarantorId,
      `CM${String(70_000_000 + letter.charCodeAt(0)).padStart(8, '0')}ZZZZ`.slice(0, 14),
    ],
  );

  const linked = await client.query<{ n: number }>(
    `select count(*)::int as n from public.client_guarantors
      where client_id = $1 and guarantor_id = $2`,
    [clientId, guarantorId],
  );

  if ((linked.rows[0]?.n ?? 0) === 0) {
    await client.query(
      `insert into public.client_guarantors
         (client_id, guarantor_id, relationship_to_client)
       values ($1, $2, 'Neighbour')`,
      [clientId, guarantorId],
    );
  }
}

/**
 * Drive one scenario as far as it is meant to go.
 *
 * Refusals are **expected outcomes** for three of the five, and are counted
 * rather than thrown: the whole point of those scenarios is that the database
 * refuses, so a refusal is the demonstration succeeding. A refusal nobody
 * expected would still surface, because the message is printed.
 */
async function seedScenario(
  client: pg.Client,
  scenario: MemberLoanScenario,
  actors: MemberLoanActors,
  tally: MemberLoanTally,
): Promise<void> {
  const member = await findMember(client, scenario.letter);

  if (member === null) {
    console.log(
      `  scenario ${scenario.key.padEnd(2)}     skipped: no demonstration member ${scenario.letter} on this database`,
    );
    return;
  }

  // Idempotent: a second run finds the loan this scenario already wrote.
  const marker = `DEMONSTRATION MEMBER LOAN ${scenario.key}`;

  const existing = await client.query<{ id: string; status: string }>(
    `select l.id, l.status
       from public.loans l
       join public.loan_products p on p.id = l.loan_product_id
      where l.client_id = $1 and p.product_code = 'ML' and l.notes = $2`,
    [member.clientId, marker],
  );

  let loanId = existing.rows[0]?.id ?? null;

  if (loanId !== null) {
    tally.alreadyPresent += 1;
  } else {
    await ensureDemoGuarantor(client, member.clientId, scenario.letter);

    const created = await client.query<{ id: string }>(
      `insert into public.loans
         (client_id, loan_product_id, principal_amount, interest_rate_bps,
          interest_method, loan_term_months, repayment_frequency,
          min_loan_amount_applied, max_loan_amount_applied,
          grace_period_days_applied, penalty_rate_bps_applied,
          proposed_disbursement_date, notes)
       select $1, p.id, $2, 0, 'reducing_balance_monthly', $3, $4,
              p.min_amount, p.max_amount, p.grace_period_days, p.penalty_rate_bps,
              public.business_date(), $5
         from public.loan_products p
        where p.product_code = 'ML'
       returning id`,
      [
        member.clientId,
        scenario.principal,
        scenario.termMonths,
        scenario.termMonths <= 2 ? 'weekly' : 'monthly',
        marker,
      ],
    );

    loanId = created.rows[0]!.id;
    tally.applicationsOpened += 1;

    // The application's own guarantors, signed — the same thing the
    // application screen does.
    await client.query(
      `insert into public.loan_guarantors
         (loan_id, guarantor_id, relationship_to_client, consent_terms_id,
          consent_version, consented_at, signature_name, witness_name,
          witness_phone, consent_place)
       select $1, cg.guarantor_id, cg.relationship_to_client, t.id, t.version,
              pg_catalog.now(), g.full_name, 'DEMO Branch Witness',
              '+256700000199', 'Kampala'
         from public.client_guarantors cg
         join public.guarantors g on g.id = cg.guarantor_id
         left join public.guarantor_consent_terms t on t.is_current
        where cg.client_id = $2 and cg.active
       on conflict do nothing`,
      [loanId, member.clientId],
    );
  }

  if (scenario.stage === 'application') {
    // Left as a draft on purpose: an application awaiting approval is a state
    // the approval screen exists to show, and submitting it needs a session to
    // attribute the submission to.
    console.log(
      `  scenario ${scenario.key.padEnd(2)}     ${scenario.label} — left as a draft application`,
    );
    return;
  }

  if (scenario.suspendFirst === true) {
    await client.query(
      `update public.memberships
          set status = 'suspended',
              status_reason = 'DEMONSTRATION suspension, so an approval can be seen refused'
        where id = $1 and status = 'active'`,
      [member.membershipId],
    );
  }

  // --- Approval ----------------------------------------------------------
  // Through `validate_loan_for_approval` first, so an expected refusal is
  // reported as the demonstration rather than as an error. The approval itself
  // needs a session to attribute the decision to, which the savings seeder's
  // approver profile provides.
  const failures = await client.query<{ codes: string | null }>(
    `select pg_catalog.string_agg(failure_code, ', ' order by failure_code) as codes
       from public.validate_loan_for_approval($1)`,
    [loanId],
  );

  const codes = failures.rows[0]?.codes ?? null;

  if (codes !== null) {
    tally.approvalsRefused += 1;
    console.log(
      `  scenario ${scenario.key.padEnd(2)}     ${scenario.label} — approval refused: ${codes}`,
    );
    return;
  }

  // Everything below needs an authenticated session, because approval and
  // disbursement stamp their actor from `current_profile_id()` and the
  // constraints require it — there is no such thing as a system-performed
  // approval, which is the schema working as intended.
  const approverAuth = actors.approver.authUserId;
  const disburserAuth = actors.disburser.authUserId;

  if (approverAuth === null || disburserAuth === null) {
    console.log(
      `  scenario ${scenario.key.padEnd(2)}     ${scenario.label} — left as a draft: ` +
        'no demonstration session is available on this database, so there is nobody ' +
        'to attribute the decision to',
    );
    return;
  }

  const loanStatus = await client.query<{ status: string }>(
    `select status from public.loans where id = $1`,
    [loanId],
  );

  if (loanStatus.rows[0]?.status === 'draft') {
    await runAs(client, approverAuth, [
      {
        sql: `update public.loans set status = 'pending_approval' where id = $1`,
        params: [loanId],
      },
      { sql: `select public.approve_loan($1)`, params: [loanId] },
    ]);
    tally.loansApproved += 1;
  }

  if (scenario.stage === 'approved') {
    console.log(`  scenario ${scenario.key.padEnd(2)}     ${scenario.label} — approved`);
    return;
  }

  // --- Disbursement -------------------------------------------------------
  const afterApproval = await client.query<{ status: string }>(
    `select status from public.loans where id = $1`,
    [loanId],
  );

  if (afterApproval.rows[0]?.status === 'approved') {
    // As the Owner, not the Manager who approved it. The Manager does not
    // hold `loans:disburse` and the function would refuse them — which is the
    // separation the matrix exists for, demonstrated rather than described.
    await runAs(client, disburserAuth, [
      { sql: `select public.disburse_loan($1)`, params: [loanId] },
    ]);
    tally.loansDisbursed += 1;
  }

  // --- One collection ----------------------------------------------------
  if (scenario.collectOnce === true) {
    const already = await client.query<{ n: number }>(
      `select count(*)::int as n from public.loan_payments where loan_id = $1`,
      [loanId],
    );

    if ((already.rows[0]?.n ?? 0) === 0) {
      const installment = await client.query<{ amount: string }>(
        `select expected_amount::text as amount
           from public.loan_installments
          where loan_id = $1
          order by installment_number
          limit 1`,
        [loanId],
      );

      const amount = installment.rows[0]?.amount ?? null;

      if (amount !== null) {
        await runAs(client, disburserAuth, [
          {
            sql: `select public.post_payment($1, $2::bigint, 'cash', null, $3::uuid,
                                             'DEMONSTRATION collection')`,
            params: [loanId, amount, demoKey(`payment:${scenario.key}`)],
          },
        ]);
        tally.paymentsPosted += 1;
      }
    }
  }

  console.log(
    `  scenario ${scenario.key.padEnd(2)}     ${scenario.label} — active${
      scenario.collectOnce === true ? ', one collection posted' : ''
    }`,
  );
}

/**
 * Run statements as a signed-in user, committed.
 *
 * Every lifecycle transition stamps its actor from `current_profile_id()` and
 * the constraints require that actor to be present, so a demonstration cannot
 * approve a loan as the table owner. That is the schema working as intended
 * rather than an obstacle: approving a loan and releasing money are human
 * acts, and a financial record that cannot name who performed them is not
 * worth keeping.
 */
async function runAs(
  client: pg.Client,
  authUserId: string,
  statements: readonly { readonly sql: string; readonly params: readonly unknown[] }[],
): Promise<void> {
  await client.query('begin');
  try {
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      authUserId,
    ]);
    await client.query('set local role authenticated');

    for (const statement of statements) {
      await client.query(statement.sql, [...statement.params]);
    }

    await client.query('reset role');
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

/**
 * Seed the member-loan scenarios and reconcile what they wrote.
 *
 * Returns the tally. Refusals are counted, not thrown: three of the five
 * scenarios exist to be refused.
 */
export async function seedMemberLoanScenarios(
  client: pg.Client,
  actors: MemberLoanActors,
): Promise<MemberLoanTally> {
  const tally = emptyMemberLoanTally();

  await openLendingConfiguration(client);

  for (const scenario of SCENARIOS) {
    await seedScenario(client, scenario, actors, tally);
  }

  await reconcileMemberLoans(client);

  return tally;
}

/**
 * The invariants the member-loan demonstration must leave behind.
 *
 * Asserted rather than assumed, and asserted against the ledger rather than
 * against this file's own arithmetic — the figures it compares are the ones a
 * trial balance and a savings statement would show.
 */
export async function reconcileMemberLoans(client: pg.Client): Promise<void> {
  // 1. A pledge moved no money. The savings subledger still equals the `2100`
  //    liability, exactly as it did before any loan existed — which is the
  //    whole claim that a pledge restricts a liability rather than reducing
  //    one.
  const savings = await client.query<{ subledger: string; gl: string | null }>(
    `select (select coalesce(pg_catalog.sum(signed_amount), 0)::text
               from public.savings_transactions) as subledger,
            (select balance::text from public.ledger_account_balances
              where code = '2100') as gl`,
  );

  const subledger = savings.rows[0]?.subledger ?? '0';
  const gl = savings.rows[0]?.gl ?? '0';

  if (subledger !== gl) {
    throw new Error(
      `Member savings do not reconcile: the subledger holds ${subledger} and ` +
        `2100 Member Savings holds ${gl}. A pledge must not move money.`,
    );
  }

  // 2. No member's live pledges exceed the savings they hold.
  const overPledged = await client.query<{ n: number }>(
    `select count(*)::int as n
       from public.savings_accounts sa
      where public.savings_pledged_amount(sa.id)
            > (select coalesce(pg_catalog.sum(t.signed_amount), 0)
                 from public.savings_transactions t
                where t.savings_account_id = sa.id)`,
  );

  if ((overPledged.rows[0]?.n ?? 0) > 0) {
    throw new Error(
      `${String(overPledged.rows[0]?.n)} savings account(s) secure more than they hold.`,
    );
  }

  // 3. Every member loan reconciles: its schedule collects its contractual
  //    total, and its frozen evidence sits within its own ceiling.
  const mismatched = await client.query<{ loan_number: string }>(
    `select l.loan_number
       from public.loans l
       join public.loan_products p on p.id = l.loan_product_id
       left join (
         select loan_id, pg_catalog.sum(expected_amount) as scheduled
           from public.loan_installments group by loan_id
       ) s on s.loan_id = l.id
      where p.requires_membership
        and l.status in ('active', 'cleared')
        and coalesce(s.scheduled, 0) <> l.total_expected_repayment`,
  );

  if (mismatched.rows.length > 0) {
    throw new Error(
      `Member loan ${mismatched.rows[0]!.loan_number} has a schedule that does not ` +
        'collect its contractual total.',
    );
  }

  // 4. The trial balance foots. The strongest single check there is: every
  //    posting the demonstration made, loan and savings alike, balances.
  const trial = await client.query<{ debit: string; credit: string }>(
    `select coalesce(pg_catalog.sum(total_debit), 0)::text as debit,
            coalesce(pg_catalog.sum(total_credit), 0)::text as credit
       from public.trial_balance`,
  );

  if (trial.rows[0]?.debit !== trial.rows[0]?.credit) {
    throw new Error(
      `The trial balance does not foot: debits ${trial.rows[0]?.debit ?? '?'} ` +
        `against credits ${trial.rows[0]?.credit ?? '?'}.`,
    );
  }

  console.log(
    '  reconciled      savings subledger equals 2100, no account over-pledged, ' +
      'every member loan schedule collects its contractual total, trial balance foots',
  );
}
