/**
 * Polytos Phase 4 demonstration data: benefits, next of kin and meetings.
 *
 * ===========================================================================
 * WHY THIS IS A SEPARATE MODE, AND LOCAL ONLY
 * ===========================================================================
 *
 * ## It publishes figures the client has not approved
 *
 * A benefit claim cannot be assessed while the rules it turns on are
 * undecided, and four of them are: the medical benefit's annual ceiling, how
 * many claims a year it allows, any waiting period, and whether the benefit
 * year runs from January or from the member's own enrolment anniversary. The
 * demonstration policy `999.0` leaves all four NULL, which is the honest
 * state of the phase — and it means `assess_benefit_claim` refuses every
 * medical claim under it with `medical_year_basis_undecided`.
 *
 * So a benefit can only be demonstrated end to end under a version that
 * answers them, and this file publishes one. Publishing it on a hosted
 * project would put figures nobody approved in front of a reader as though
 * they were the programme's terms — which is exactly what §1 of the brief
 * forbids. So this mode refuses any target but a local throwaway database,
 * by *kind* rather than by project name, which is the reasoning the
 * allow-list in `seed-demo.ts` uses.
 *
 * It also writes `condolence_eligible` on three family relationships, and
 * that is the same kind of figure: **nobody has defined an eligible family
 * member**. A spouse, a child and a parent are the three nobody would argue
 * with, which is not the same as the client having decided, and the row
 * carries TEST ONLY in its own label so a reader cannot mistake it.
 *
 * ## It is mutually exclusive with the member-loan mode, and why
 *
 * Only one policy version may be in force, and a savings account is frozen to
 * the version it was opened under — so publishing a second version
 * supersedes the first and silently un-qualifies every savings account opened
 * under it. `scripts/demo-member-loans.ts` documents this at length; the
 * consequence here is that the benefits version has to be the
 * demonstration's only version too.
 *
 * A single version answering both sets would present seven unapproved figures
 * at once, and a reader looking at the policy screen would have no way to tell
 * which demonstration each belonged to. So the two modes refuse to run
 * together and each says so.
 *
 * ## It back-dates the demonstration memberships, and why it has to
 *
 * `is_benefits_enabled` is a generated column that waits on all three of the
 * medical cap, the claims-per-year limit **and** the waiting period — so a
 * waiting period has to be answered for anything to be assessable at all, and
 * that answer is measured from the member's activation.
 *
 * `seed-demo.ts` enrols its members today. Every claim in the demonstration
 * would therefore be held with `waiting_period_not_served`: one refusal shown
 * and nine other things hidden. So this mode moves the demonstration
 * memberships' `applied_on` and `activated_on` back, under the documented
 * owner-level trigger exemption the test fixtures use — and the result is
 * more coherent rather than less, because six months of savings deposits on a
 * membership activated this morning never made sense either.
 *
 * It is a write to a column the application cannot write, which is why it
 * happens here, on a local throwaway database, and nowhere near a hosted
 * project.
 *
 * ## Idempotency
 *
 * By construction, as both earlier seeders are. Every record is found before
 * it is created, every payment carries a deterministic idempotency key
 * derived from what it represents, and the lifecycle functions refuse a
 * second submission, assessment, approval or payment by state. Running it ten
 * times produces the same database as running it once, and a second run posts
 * no money.
 *
 * ## What it never does
 *
 * It creates no client and no membership — every scenario attaches to a
 * member `seed-demo.ts` already created, by letter. It writes no loan, no
 * savings transaction and no second ledger: a benefit payment posts through
 * `post_benefit_payment`, which writes one journal entry through
 * `post_journal` like every other movement in this system.
 *
 * Every claim, every document, every beneficiary and every meeting it writes
 * is labelled DEMONSTRATION in a column a reader sees. A synthetic approval
 * must never be mistakable for a management decision.
 */

import { createHash } from 'node:crypto';

import type pg from 'pg';

export const BENEFIT_ENABLE_PHRASE = 'yes-seed-polytos-benefit-demo';

/**
 * The version the benefits demonstration is held to.
 *
 * `997.0`, where savings use `999.0` and member lending `998.0`. Three
 * numbers far outside anything the business would publish, and distinct so
 * the policy list says which demonstration a version belongs to.
 */
export const BENEFIT_POLICY_VERSION = '997.0';

/**
 * The four TEST ONLY answers, named as constants so the refusals below can
 * quote them and so a reader can see every invented figure in one place.
 *
 * **None of these is a Polytos decision.** The cap is small on purpose: it
 * has to be small enough that two ordinary hospital bills can be seen
 * reaching it, which is the only reason this number is this number.
 */
export const DEMO_MEDICAL_ANNUAL_CAP = 150_000;
export const DEMO_MEDICAL_CLAIMS_PER_YEAR = 3;
export const DEMO_WAITING_PERIOD_DAYS = 30;
export const DEMO_YEAR_BASIS = 'calendar_year';

/**
 * How far back the demonstration memberships are moved.
 *
 * Far enough that the waiting period above is served and that six months of
 * savings deposits belong to a membership old enough to have made them.
 */
export const DEMO_ACTIVATION_DAYS_AGO = 220;

/** The relationships this demonstration treats as eligible for condolence. */
export const DEMO_CONDOLENCE_ELIGIBLE: readonly string[] = [
  'spouse', 'child', 'parent', 'sibling', 'grandparent', 'grandchild',
  'uncle_aunt', 'nephew_niece', 'cousin', 'other_relative',
];

export interface BenefitActors {
  /** Holds `beneficiaries:manage` and `benefits:claim`. The Secretary. */
  readonly recorder: { readonly authUserId: string | null };
  /** Holds `beneficiaries:verify`, `benefits:assess` and `benefits:pay`. A Manager. */
  readonly checker: { readonly authUserId: string | null };
  /** Holds `benefits:approve` and `savings:reverse`. The Owner. */
  readonly approver: { readonly authUserId: string | null };
}

export interface BenefitTally {
  beneficiariesRegistered: number;
  beneficiariesVerified: number;
  claimsOpened: number;
  documentsAttached: number;
  claimsAssessed: number;
  claimsApproved: number;
  claimsPaid: number;
  claimsRefused: number;
  claimsHeld: number;
  paymentsReversed: number;
  meetingsScheduled: number;
  attendanceMarked: number;
  actionsRecorded: number;
  alreadyPresent: number;
}

export function emptyBenefitTally(): BenefitTally {
  return {
    beneficiariesRegistered: 0,
    beneficiariesVerified: 0,
    claimsOpened: 0,
    documentsAttached: 0,
    claimsAssessed: 0,
    claimsApproved: 0,
    claimsPaid: 0,
    claimsRefused: 0,
    claimsHeld: 0,
    paymentsReversed: 0,
    meetingsScheduled: 0,
    attendanceMarked: 0,
    actionsRecorded: 0,
    alreadyPresent: 0,
  };
}

/** The same deterministic key derivation both earlier seeders use. */
function demoKey(seed: string): string {
  const digest = createHash('sha256').update(`polytos-benefit:${seed}`).digest('hex');

  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

/** Whether the benefits demonstration is enabled. */
export function benefitDemoRequested(enable: string | undefined): boolean {
  return (enable ?? '') === BENEFIT_ENABLE_PHRASE;
}

export class BenefitDemoRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenefitDemoRefused';
  }
}

/**
 * Publish the TEST ONLY benefits policy, or refuse and say why.
 *
 * Called **before** `seed-demo.ts` publishes its own, so the savings
 * scenarios enrol under this version too — see the head of this file, and
 * `scripts/demo-member-loans.ts` for the Phase 2 behaviour that makes it
 * necessary.
 */
export async function ensureBenefitPolicy(client: pg.Client): Promise<string> {
  const existing = await client.query<{ id: string; version: string }>(
    `select id, version from public.membership_policy_versions where version = $1`,
    [BENEFIT_POLICY_VERSION],
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
    throw new BenefitDemoRefused(
      `Policy version ${active.rows[0]!.version} is already in force, and only one may be.\n\n` +
        'Publishing the benefits TEST ONLY version would supersede it, and every savings\n' +
        'account opened under it would stop qualifying — a savings account is frozen to\n' +
        'the version it was opened under, and a superseded version authorises nothing.\n' +
        'See the head of scripts/demo-member-loans.ts.\n\n' +
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
        medical_benefit_annual_cap, medical_benefit_claims_per_year,
        benefit_waiting_period_days, medical_benefit_year_basis,
        medical_benefit_cap_mode, benefit_qualification_basis, death_confirmations_required,
        qualifying_months_consecutive, savings_withdrawal_with_active_loan,
        notes)
     values
       ($1,
        'TEST ONLY — membership benefits demonstration, not the approved Polytos policy',
        (public.business_date() - 400), 'active',
        pg_catalog.now(), 'TEST ONLY seeder',
        5000, 50000, 6,
        500, 5, 2, 3,
        500, 1, 100000, 200000,
        $2::bigint, $3::int, $4::int, $5,
        'amount', 'waiting_period_days', 3,
        false, 'above_pledged',
        'Published by scripts/demo-benefits.ts so a benefit claim can be '
          || 'demonstrated end to end on an isolated database. The annual cap, the '
          || 'claims-per-year limit, the waiting period and the benefit year are the '
          || 'four decisions the client has NOT made; the values here are illustrative '
          || 'and must not be read as decisions. The two savings rules are answered '
          || 'the same way scripts/demo-member-loans.ts answers them, and for the same '
          || 'reason: without them no savings account opens, and the benefits '
          || 'demonstration would have no members with a savings history. They are '
          || 'illustrative too. The confirmed figures — the 5% '
          || 'medical rate, the admission longer than one day, the UGX 100,000 family '
          || 'condolence benefit and the UGX 200,000 member bereavement benefit — are '
          || 'the client''s own.')
     returning id`,
    [
      BENEFIT_POLICY_VERSION,
      DEMO_MEDICAL_ANNUAL_CAP,
      DEMO_MEDICAL_CLAIMS_PER_YEAR,
      DEMO_WAITING_PERIOD_DAYS,
      DEMO_YEAR_BASIS,
    ],
  );

  console.log(
    `  policy          published TEST ONLY version ${BENEFIT_POLICY_VERSION} ` +
      '(benefits open; four figures are illustrative)',
  );

  return created.rows[0]!.id;
}

/**
 * Move the demonstration memberships back, so the waiting period is served.
 *
 * `memberships_guard_transition` refuses a change to `applied_on` or
 * `activated_on` outside the transition that stamps it — a caller who could
 * set those freely could backdate a savings qualification by six months, which
 * is exactly why the rule exists. So this disables the trigger for the
 * statement and puts it straight back, which is the owner-level exemption the
 * test fixtures use and document.
 *
 * It is safe **here** for the reasons it is safe there: a local throwaway
 * database, a statement that names only the demonstration memberships, and a
 * seeder that cannot run on a hosted project at all. It would not be safe
 * anywhere else, and nothing in the application can do it.
 */
async function backdateDemonstrationMemberships(client: pg.Client): Promise<void> {
  await client.query(
    `alter table public.memberships disable trigger memberships_guard_transition`,
  );

  try {
    const moved = await client.query(
      `update public.memberships
          set applied_on = (public.business_date() - $1::int),
              activated_on = case
                when activated_on is null then null
                else (public.business_date() - $1::int)
              end
        where notes like 'DEMONSTRATION SCENARIO %'
          and applied_on > (public.business_date() - $1::int)`,
      [DEMO_ACTIVATION_DAYS_AGO],
    );

    console.log(
      `  memberships     moved ${String(moved.rowCount ?? 0)} demonstration ` +
        `membership(s) back ${String(DEMO_ACTIVATION_DAYS_AGO)} days, so the ` +
        'TEST ONLY waiting period is served',
    );
  } finally {
    await client.query(
      `alter table public.memberships enable trigger memberships_guard_transition`,
    );
  }
}

/**
 * Decide, TEST ONLY, which relatives a condolence benefit covers.
 *
 * Spouse, child and parent — the three nobody would argue with, which is not
 * the same as the client having decided. Every other relationship stays NULL,
 * so a cousin still produces `relationship_eligibility_undecided` and the
 * demonstration shows both arms.
 *
 * The label carries TEST ONLY because the label is what a reader sees on the
 * form; a flag they cannot see would be a decision made invisibly.
 */
async function openCondolenceVocabulary(client: pg.Client): Promise<void> {
  const result = await client.query<{ count: string }>(
    'select count(*)::text from public.beneficiary_relationships where key = any($1::text[]) and condolence_eligible',
    [DEMO_CONDOLENCE_ELIGIBLE],
  );
  if (result.rows[0]?.count !== String(DEMO_CONDOLENCE_ELIGIBLE.length)) {
    throw new Error('Apply the policy family-eligibility migration before seeding this demonstration.');
  }
  console.log('  vocabulary      official family relationships preserved; no demo overrides');
}

/**
 * Run statements as one member of staff, committed.
 *
 * The same impersonation `seed-demo.ts` uses: the JWT subject plus
 * `set local role authenticated` is what PostgREST does for a browser
 * request, so every statement goes through Row Level Security and through
 * each function's own capability check as that person. A seeder that wrote
 * around those checks would produce data the product could not produce — and
 * for this phase that would be the whole point missed, because the controls
 * *are* the deliverable: an approval refused to the assessor, a verification
 * refused to the uploader.
 */
async function asStaff<T>(
  client: pg.Client,
  staff: { readonly authUserId: string | null },
  run: () => Promise<T>,
): Promise<T> {
  if (staff.authUserId === null) return run();

  await client.query('begin');
  try {
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      staff.authUserId,
    ]);
    await client.query('set local role authenticated');
    const result = await run();
    await client.query('reset role');
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

/**
 * Run as one member of staff and treat a refusal as an outcome.
 *
 * Several of the scenarios below are *meant* to be refused — a short
 * admission, a cousin, a membership never activated. The refusal is the
 * demonstration succeeding, so it is returned rather than thrown, and the
 * message is printed so a refusal nobody expected still surfaces.
 */
async function tryAsStaff(
  client: pg.Client,
  staff: { readonly authUserId: string | null },
  run: () => Promise<void>,
): Promise<string | null> {
  try {
    await asStaff(client, staff, run);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

interface ScenarioMember {
  readonly clientId: string;
  readonly membershipId: string;
  readonly branchId: string | null;
  readonly status: string;
}

/** The member a scenario attaches to, found by the letter in its notes. */
async function findMember(
  client: pg.Client,
  letter: string,
): Promise<ScenarioMember | null> {
  const row = await client.query<{
    client_id: string;
    membership_id: string;
    branch_id: string | null;
    status: string;
  }>(
    `select m.client_id, m.id as membership_id, c.branch_id, m.status
       from public.memberships m
       join public.clients c on c.id = m.client_id
      where m.notes like $1
      limit 1`,
    [`DEMONSTRATION SCENARIO ${letter} %`],
  );

  const found = row.rows[0];
  if (found === undefined) return null;

  return {
    clientId: found.client_id,
    membershipId: found.membership_id,
    branchId: found.branch_id,
    status: found.status,
  };
}

/**
 * Put an object in the evidence bucket, so a document can be attached to it.
 *
 * `attach_benefit_document` refuses a path naming a file nobody uploaded —
 * that is the decorative-evidence failure in its purest form, a claim that
 * looks documented with nothing to look at. So the demonstration puts a real
 * row in `storage.objects`, exactly as the test fixtures do.
 *
 * The path is derived from what it represents rather than randomised, so a
 * second run finds the same object instead of filling the bucket.
 */
async function putEvidenceObject(
  client: pg.Client,
  membershipId: string,
  kind: string,
  subject: string,
  seed: string,
): Promise<string> {
  const path = `benefits/${membershipId}/${kind}/${subject}/${demoKey(seed)}.pdf`;

  await client.query(
    `insert into storage.objects (bucket_id, name, metadata)
     values ('benefit-documents', $1, jsonb_build_object('size', 20480))
     on conflict (bucket_id, name) do nothing`,
    [path],
  );

  return path;
}

// ---------------------------------------------------------------------------
// The beneficiary scenarios
// ---------------------------------------------------------------------------

/**
 * What each member's next of kin demonstrates.
 *
 * Six members, six states, because every one of them is a state somebody
 * working the register has to be able to recognise:
 *
 *   A  verified, and the payee a bereavement claim would freeze
 *   B  verified, and the one this demonstration actually pays
 *   C  registered and unchecked — the amber row the register exists to find
 *   D  replaced, so the supersession chain can be read
 *   E  refused, with the reason on the record
 *   F  none at all, on a membership that was never activated
 */
interface BeneficiaryScenario {
  readonly letter: string;
  readonly fullName: string;
  readonly relationship: string;
  readonly phone: string;
  readonly outcome: 'verified' | 'pending' | 'refused' | 'replaced';
  /** For `replaced`: who the replacement names. */
  readonly replacementName?: string;
  readonly replacementRelationship?: string;
  readonly replacementPhone?: string;
}

const BENEFICIARIES: readonly BeneficiaryScenario[] = [
  {
    letter: 'A',
    fullName: 'DEMO Hadija Nakato',
    relationship: 'spouse',
    phone: '+256700000301',
    outcome: 'verified',
  },
  {
    letter: 'B',
    fullName: 'DEMO Florence Okello',
    relationship: 'spouse',
    phone: '+256700000302',
    outcome: 'verified',
  },
  {
    letter: 'C',
    fullName: 'DEMO Peter Atim',
    relationship: 'child',
    phone: '+256700000303',
    outcome: 'pending',
  },
  {
    letter: 'D',
    fullName: 'DEMO Betty Mugisha',
    relationship: 'sibling',
    phone: '+256700000304',
    outcome: 'replaced',
    replacementName: 'DEMO Esther Mugisha',
    replacementRelationship: 'spouse',
    replacementPhone: '+256700000314',
  },
  {
    letter: 'E',
    fullName: 'DEMO Unknown Achieng',
    relationship: 'cousin',
    phone: '+256700000305',
    outcome: 'refused',
  },
];

/**
 * Register one member's next of kin, and take it as far as its scenario goes.
 *
 * Two people throughout, and that is the control rather than the decoration:
 * `verify_member_beneficiary` refuses a check from whoever recorded the
 * record. A demonstration that registered and verified as one profile would
 * render the separation as though it were not there, which is the mistake the
 * savings seeder's two-actor withdrawal was written to avoid.
 */
async function seedBeneficiary(
  client: pg.Client,
  scenario: BeneficiaryScenario,
  actors: BenefitActors,
  tally: BenefitTally,
): Promise<void> {
  const member = await findMember(client, scenario.letter);

  if (member === null) {
    console.log(
      `  beneficiary ${scenario.letter}   skipped: no demonstration member on this database`,
    );
    return;
  }

  const existing = await client.query<{ id: string; status: string }>(
    `select id, status from public.member_beneficiaries
      where membership_id = $1 order by beneficiary_number`,
    [member.membershipId],
  );

  if (existing.rows.length > 0) {
    tally.alreadyPresent += 1;
    console.log(
      `  beneficiary ${scenario.letter}   already present (${String(existing.rows.length)} record(s))`,
    );
    return;
  }

  let beneficiaryId: string | null = null;

  await asStaff(client, actors.recorder, async () => {
    const registered = await client.query<{ id: string }>(
      `select public.register_member_beneficiary(
                $1, $2, $3, $4, null, 'Kalerwe', 'Kampala',
                'national_id', $5, true, null) as id`,
      [
        member.membershipId,
        scenario.fullName,
        scenario.relationship,
        scenario.phone,
        `CM${String(90_000_000 + scenario.letter.charCodeAt(0)).padStart(8, '0')}DEMO`.slice(
          0,
          14,
        ),
      ],
    );
    beneficiaryId = registered.rows[0]?.id ?? null;
  });

  if (beneficiaryId === null) {
    console.log(`  beneficiary ${scenario.letter}   not registered`);
    return;
  }

  tally.beneficiariesRegistered += 1;

  if (scenario.outcome === 'pending') {
    tally.claimsHeld += 0;
    console.log(
      `  beneficiary ${scenario.letter}   registered and deliberately unchecked — ` +
        'a bereavement benefit could not be paid on it',
    );
    return;
  }

  if (scenario.outcome === 'refused') {
    await asStaff(client, actors.checker, async () => {
      await client.query(
        `select public.verify_member_beneficiary(
                  $1, false, 'relationship_document', null, $2)`,
        [
          beneficiaryId,
          'DEMONSTRATION: the relationship document named somebody else. A replacement was asked for.',
        ],
      );
    });

    console.log(
      `  beneficiary ${scenario.letter}   refused, with the reason on the record`,
    );
    return;
  }

  // Verified against a document that actually exists in the bucket, under
  // this membership's own folder — which is what the database checks.
  const path = await putEvidenceObject(
    client,
    member.membershipId,
    'relationship_evidence',
    'beneficiary',
    `beneficiary:${scenario.letter}`,
  );

  await asStaff(client, actors.recorder, async () => {
    await client.query(
      `select public.attach_benefit_document(
                null, $1, 'relationship_evidence', $2, 'application/pdf', 20480,
                'DEMONSTRATION relationship evidence')`,
      [beneficiaryId, path],
    );
  });
  tally.documentsAttached += 1;

  await asStaff(client, actors.checker, async () => {
    await client.query(
      `select public.verify_member_beneficiary(
                $1, true, 'relationship_document', $2, $3)`,
      [
        beneficiaryId,
        path,
        'DEMONSTRATION: checked against the relationship document in the evidence folder.',
      ],
    );
  });
  tally.beneficiariesVerified += 1;

  if (scenario.outcome === 'verified') {
    console.log(
      `  beneficiary ${scenario.letter}   verified by somebody other than the recorder`,
    );
    return;
  }

  // --- replaced ----------------------------------------------------------
  //
  // A change is a new record that supersedes the old one, in one statement, so
  // there is never a moment at which both are live. The old record keeps its
  // details *and its verification*, which is what makes a payment made against
  // it years ago still explicable.
  await asStaff(client, actors.recorder, async () => {
    await client.query(
      `select public.register_member_beneficiary(
                $1, $2, $3, $4, null, 'Kamwokya', 'Kampala',
                'national_id', $5, true, $6) as id`,
      [
        member.membershipId,
        scenario.replacementName,
        scenario.replacementRelationship,
        scenario.replacementPhone,
        'CM90000099DEMO',
        beneficiaryId,
      ],
    );
  });

  tally.beneficiariesRegistered += 1;
  console.log(
    `  beneficiary ${scenario.letter}   replaced; the superseded record keeps its ` +
      'details and its verification',
  );
}

// ---------------------------------------------------------------------------
// The claim scenarios
// ---------------------------------------------------------------------------

/**
 * Ten claims, and what each one is for.
 *
 * Four of them are **meant to be refused or held**, and that is the point:
 * the controls are the deliverable in this phase, and a demonstration that
 * showed only successful claims would show none of them. Each held claim
 * names the decision it is waiting on, which is what the screens show a
 * reader.
 *
 *   A medical, paid      the whole lifecycle, ending in a journal entry
 *   A medical, held      the annual ceiling reached, with partial payment undefined
 *   B medical, refused   an admission too short on every reading
 *   C medical, held      the three readings disagree about "longer than one day"
 *   D medical, draft     recorded and not yet submitted, so nothing is frozen
 *   D condolence, held   a cousin, and nobody has defined an eligible relative
 *   E condolence, paid   UGX 100,000 to the member
 *   E condolence, paid then reversed    the contra entry, and a terminal claim
 *   B bereavement, paid  UGX 200,000 to a verified next of kin
 *   F medical, held      a membership that was never activated
 */
type ClaimOutcome = 'paid' | 'reversed' | 'refused' | 'held' | 'draft';

interface ClaimScenario {
  readonly key: string;
  readonly letter: string;
  readonly label: string;
  readonly claimType: 'medical' | 'family_condolence' | 'member_bereavement';
  readonly outcome: ClaimOutcome;
  /** Medical. */
  readonly providerName?: string;
  readonly admissionDaysAgo?: number;
  readonly admissionHour?: number;
  readonly dischargeDaysAgo?: number;
  readonly dischargeHour?: number;
  readonly billAmount?: number;
  /** Condolence and bereavement. */
  readonly deceasedName?: string;
  readonly deceasedRelationship?: string;
  readonly eventDaysAgo?: number;
  /** Mark the membership deceased first, as a bereavement claim implies. */
  readonly markDeceased?: boolean;
  /** Suspend the membership first, so the undecided consequence can be seen. */
  readonly markSuspended?: boolean;
  /** Attach the required evidence and have it checked. */
  readonly withEvidence?: boolean;
}

const CLAIMS: readonly ClaimScenario[] = [
  {
    key: 'A-medical',
    letter: 'A',
    label: 'a medical claim paid end to end',
    claimType: 'medical',
    outcome: 'paid',
    providerName: 'DEMO Mulago Specialised Hospital',
    // Four nights, five ward days, four clock days: longer than one day on
    // every reading, so the measure question does not arise.
    admissionDaysAgo: 20,
    admissionHour: 8,
    dischargeDaysAgo: 16,
    dischargeHour: 10,
    // 5% of 400,000 is exactly 20,000 — the figure the brief quotes.
    billAmount: 400_000,
    withEvidence: true,
  },
  {
    key: 'A-cap',
    letter: 'A',
    label: 'a second medical claim held by the annual ceiling',
    claimType: 'medical',
    outcome: 'held',
    providerName: 'DEMO Nsambya Hospital',
    admissionDaysAgo: 10,
    admissionHour: 7,
    dischargeDaysAgo: 7,
    dischargeHour: 11,
    // 5% of 3,000,000 is 150,000. The first claim has already consumed
    // 20,000 of the TEST ONLY 150,000 ceiling, so this one cannot be paid in
    // full — and whether a benefit may be paid in part is undecided, so it is
    // held rather than trimmed.
    billAmount: 3_000_000,
    withEvidence: true,
  },
  {
    key: 'B-short',
    letter: 'B',
    label: 'a medical claim refused for an admission too short',
    claimType: 'medical',
    outcome: 'refused',
    providerName: 'DEMO Kawempe Health Centre',
    // In at 08:00 and out at 18:00 the same day: nought nights, one ward day,
    // nought clock days. Short on every reading, so the refusal is certain
    // rather than a question about the measure.
    admissionDaysAgo: 5,
    admissionHour: 8,
    dischargeDaysAgo: 5,
    dischargeHour: 18,
    billAmount: 120_000,
    withEvidence: true,
  },
  {
    key: 'C-measure',
    letter: 'C',
    label: 'a medical claim held because the three readings disagree',
    claimType: 'medical',
    outcome: 'held',
    providerName: 'DEMO Kiruddu Hospital',
    // In at 22:00, out at 09:00 the next morning: one night, two ward days,
    // nought clock days. One reading clears the threshold and two do not,
    // which is exactly the stay nobody has decided how to count.
    admissionDaysAgo: 6,
    admissionHour: 22,
    dischargeDaysAgo: 5,
    dischargeHour: 9,
    billAmount: 260_000,
    withEvidence: true,
  },
  {
    key: 'D-draft',
    letter: 'D',
    label: 'a medical claim recorded as a draft, nothing frozen yet',
    claimType: 'medical',
    outcome: 'draft',
    providerName: 'DEMO Kamwokya Clinic',
    admissionDaysAgo: 3,
    admissionHour: 9,
    dischargeDaysAgo: 1,
    dischargeHour: 12,
    billAmount: 180_000,
  },
  {
    key: 'D-condolence',
    letter: 'D',
    label: 'a family claim held because the deceased was not listed as next of kin',
    claimType: 'family_condolence',
    outcome: 'held',
    deceasedName: 'DEMO Alice Mugisha',
    deceasedRelationship: 'cousin',
    eventDaysAgo: 12,
    withEvidence: true,
  },
  {
    key: 'E-condolence',
    letter: 'E',
    label: 'a condolence claim paid in full',
    claimType: 'family_condolence',
    outcome: 'paid',
    deceasedName: 'DEMO Margaret Achieng',
    deceasedRelationship: 'parent',
    eventDaysAgo: 25,
    withEvidence: true,
  },
  {
    key: 'E-reversed',
    letter: 'E',
    label: 'a condolence claim paid and then reversed by a contra entry',
    claimType: 'family_condolence',
    outcome: 'reversed',
    deceasedName: 'DEMO Johnson Achieng',
    deceasedRelationship: 'child',
    eventDaysAgo: 18,
    withEvidence: true,
  },
  {
    key: 'B-bereavement',
    letter: 'B',
    label: 'a bereavement benefit paid to a verified next of kin',
    claimType: 'member_bereavement',
    outcome: 'paid',
    deceasedName: 'DEMO Joseph Okello',
    eventDaysAgo: 2,
    markDeceased: true,
    withEvidence: true,
  },
  {
    key: 'D-suspended',
    letter: 'D',
    label: 'a claim held because nobody has decided what a suspension costs',
    claimType: 'medical',
    outcome: 'held',
    providerName: 'DEMO Nakawa Clinic',
    admissionDaysAgo: 8,
    admissionHour: 9,
    dischargeDaysAgo: 4,
    dischargeHour: 15,
    billAmount: 300_000,
    withEvidence: true,
    // Suspended first, and last in the list on purpose: D's condolence claim
    // above has to be held for its own reason — the undecided relative —
    // rather than for this one.
    markSuspended: true,
  },
];

/**
 * Member F is deliberately not in this list.
 *
 * `open_benefit_claim` refuses a pending membership outright — "a benefit may
 * be claimed against an active, suspended or deceased membership" — so there
 * is no claim to record against F at all, and the `membership_not_claimable`
 * code exists for a membership that was *withdrawn* after a claim was opened
 * rather than for one that was never activated. That is the stricter and
 * better behaviour, and it means the refusal belongs in a test rather than in
 * a demonstration: `tests/db/benefit-claims.test.ts` drives it.
 */

/** The evidence kinds a claim of each type cannot be assessed without. */
const REQUIRED_EVIDENCE: Readonly<Record<string, readonly string[]>> = {
  medical: ['hospital_admission', 'medical_invoice'],
  family_condolence: ['family_death_evidence', 'relationship_evidence'],
  member_bereavement: ['member_death_evidence'],
};

/**
 * Drive one claim as far as its scenario goes.
 *
 * Four people pass through a paid claim, and not one of them could do
 * another's part: the Secretary opens it and brings the documents, a Manager
 * checks the documents and assesses the amount, the Owner approves it — and
 * is refused if they were the assessor — and a Manager pays. Every step runs
 * as that person, through the same functions the screens call, so the
 * demonstration data cannot drift into a state the product could not produce.
 */
async function seedClaim(
  client: pg.Client,
  scenario: ClaimScenario,
  actors: BenefitActors,
  tally: BenefitTally,
): Promise<void> {
  const member = await findMember(client, scenario.letter);

  if (member === null) {
    console.log(
      `  claim ${scenario.key.padEnd(14)} skipped: no demonstration member ${scenario.letter}`,
    );
    return;
  }

  const marker = `DEMONSTRATION CLAIM ${scenario.key}`;

  // Idempotent: a second run finds the claim this scenario already wrote. The
  // marker lives in the assessment note where there is one and in the claim's
  // own documents otherwise, so the lookup is by the deterministic evidence
  // path rather than by a notes column the claim does not have.
  const existing = await client.query<{ id: string; status: string }>(
    `select c.id, c.status
       from public.benefit_claims c
      where c.membership_id = $1
        and c.claim_type = $2
        and coalesce(c.provider_name, c.deceased_name, '') = $3`,
    [
      member.membershipId,
      scenario.claimType,
      scenario.providerName ?? scenario.deceasedName ?? '',
    ],
  );

  if (existing.rows.length > 0) {
    tally.alreadyPresent += 1;
    console.log(
      `  claim ${scenario.key.padEnd(14)} already present (${existing.rows[0]!.status})`,
    );
    return;
  }

  // A bereavement claim implies the member has died, so the membership is
  // moved first. On the trusted path, because the lifecycle screen belongs to
  // a later phase and there is no function for it yet — the guard stamps
  // `ended_on` and the history row either way.
  if (scenario.markDeceased === true && member.status !== 'deceased') {
    await client.query(
      `update public.memberships
          set status = 'deceased',
              status_reason = 'DEMONSTRATION: recorded deceased so a bereavement benefit can be demonstrated.'
        where id = $1 and status in ('active', 'suspended', 'pending')`,
      [member.membershipId],
    );
  }

  if (scenario.markSuspended === true && member.status === 'active') {
    await client.query(
      `update public.memberships
          set status = 'suspended',
              status_reason = 'DEMONSTRATION: suspended so the undecided consequence of a suspension can be seen on a claim.'
        where id = $1 and status = 'active'`,
      [member.membershipId],
    );
  }

  let deceasedKinId: string | null = null;
  if (scenario.claimType === 'family_condolence'
      && (scenario.outcome === 'paid' || scenario.outcome === 'reversed')) {
    await asStaff(client, actors.recorder, async () => {
      const registered = await client.query<{ id: string }>(
        `select public.register_member_beneficiary(
          $1, $2, $3, '+256700000399', null, 'Kalerwe', 'Kampala',
          null, null, false, null) as id`,
        [member.membershipId, scenario.deceasedName, scenario.deceasedRelationship],
      );
      deceasedKinId = registered.rows[0]!.id;
    });
    await client.query(`update public.member_beneficiaries
      set created_at = ((public.business_date() - $2::int - 30) + time '09:00')
        at time zone 'Africa/Kampala' where id = $1`,
      [deceasedKinId, scenario.eventDaysAgo]);
    tally.beneficiariesRegistered += 1;
  }

  let claimId: string | null = null;

  await asStaff(client, actors.recorder, async () => {
    const opened = await client.query<{ id: string }>(
      scenario.claimType === 'medical'
        ? // The admission and discharge times are **Kampala wall clock**, read
          // through `at time zone`. Writing them as plain timestamps would
          // have the cluster read them as UTC, and a 22:00 admission would
          // land at 01:00 the next day in Kampala — which changes the night
          // count, which changes which of the three readings clear the
          // threshold, which changes the scenario into a different one.
          `select public.open_benefit_claim(
                    $1, 'medical', null, $2,
                    (((public.business_date() - $3::int)
                       + ($4::int || ' hours')::interval) at time zone 'Africa/Kampala'),
                    (((public.business_date() - $5::int)
                       + ($6::int || ' hours')::interval) at time zone 'Africa/Kampala'),
                    $7::bigint, null, null, null) as id`
        : scenario.claimType === 'family_condolence'
          ? `select public.open_benefit_claim(
                      $1, 'family_condolence', (public.business_date() - $2::int),
                      null, null, null, null, $3, $4, null, $5::uuid) as id`
          : `select public.open_benefit_claim(
                      $1, 'member_bereavement', (public.business_date() - $2::int),
                      null, null, null, null, $3, null,
                      (select b.id from public.member_beneficiaries b
                        where b.membership_id = $1 and b.status = 'active'
                          and b.verification_status = 'verified'
                        order by b.is_primary desc, b.beneficiary_number
                        limit 1)) as id`,
      scenario.claimType === 'medical'
        ? [
            member.membershipId,
            scenario.providerName,
            scenario.admissionDaysAgo,
            scenario.admissionHour,
            scenario.dischargeDaysAgo,
            scenario.dischargeHour,
            scenario.billAmount,
          ]
        : scenario.claimType === 'family_condolence'
          ? [
              member.membershipId,
              scenario.eventDaysAgo,
              scenario.deceasedName,
              scenario.deceasedRelationship,
              deceasedKinId,
            ]
          : [member.membershipId, scenario.eventDaysAgo, scenario.deceasedName],
    );

    claimId = opened.rows[0]?.id ?? null;
  });

  if (claimId === null) {
    console.log(`  claim ${scenario.key.padEnd(14)} not opened`);
    return;
  }

  tally.claimsOpened += 1;

  if (scenario.outcome === 'draft') {
    console.log(`  claim ${scenario.key.padEnd(14)} ${scenario.label} — left as a draft`);
    return;
  }

  // --- The evidence, in the order the database insists on ----------------
  //
  // Attached while the claim is still a draft — a member brings their papers
  // over the counter with the claim, not afterwards — and **checked** only
  // once the claim is under verification, because `verify_benefit_document`
  // refuses a conclusion about evidence on a claim nobody is working on. The
  // two acts are separated by two people as well as by two states: the
  // function refuses a check from whoever attached the document, since
  // evidence uploaded and attested by one hand is evidence nobody checked.
  const documentIds: string[] = [];

  if (scenario.withEvidence === true) {
    for (const kind of REQUIRED_EVIDENCE[scenario.claimType] ?? []) {
      const path = await putEvidenceObject(
        client,
        member.membershipId,
        kind,
        claimId,
        `${scenario.key}:${kind}`,
      );

      await asStaff(client, actors.recorder, async () => {
        const attached = await client.query<{ id: string }>(
          `select public.attach_benefit_document(
                    $1, null, $2, $3, 'application/pdf', 20480, $4) as id`,
          [claimId, kind, path, `${marker} evidence`],
        );

        const id = attached.rows[0]?.id;
        if (id !== undefined) documentIds.push(id);
      });

      tally.documentsAttached += 1;
    }
  }

  // --- Submit, and pick it up -------------------------------------------
  await asStaff(client, actors.recorder, async () => {
    await client.query(`select public.submit_benefit_claim($1)`, [claimId]);
  });

  await asStaff(client, actors.checker, async () => {
    await client.query(`select public.begin_benefit_verification($1)`, [claimId]);
  });

  for (const documentId of documentIds) {
    await asStaff(client, actors.checker, async () => {
      await client.query(`select public.verify_benefit_document($1, true, $2)`, [
        documentId,
        'DEMONSTRATION: checked against the document in the folder.',
      ]);
    });
  }

  if (scenario.claimType !== 'medical') {
    const confirmers = await client.query<{ id: string }>(
      `select id from public.memberships
        where notes like 'DEMONSTRATION SCENARIO %' and status = 'active'
          and id <> $1 order by membership_number limit 3`,
      [member.membershipId],
    );
    if (confirmers.rows.length !== 3) {
      throw new Error('The benefit demo needs three other active demonstration members.');
    }
    for (const confirmer of confirmers.rows) {
      await asStaff(client, actors.recorder, async () => {
        await client.query(`select public.record_death_confirmation(
          $1, $2, 'DEMONSTRATION: the group member confirms this synthetic death.',
          'witnessed_by_staff', null, null, 'DEMONSTRATION group member')`,
          [claimId, confirmer.id]);
      });
    }
  }

  // --- Assess ------------------------------------------------------------
  //
  // A refusal here is the demonstration succeeding for five of the ten
  // scenarios, so it is caught and reported rather than thrown.
  const refusal = await tryAsStaff(client, actors.checker, async () => {
    await client.query(`select public.assess_benefit_claim($1, $2)`, [
      claimId,
      `${marker}: assessed from the claim's own policy version.`,
    ]);
  });

  if (refusal !== null) {
    tally.claimsHeld += 1;

    if (scenario.outcome === 'refused') {
      // A claim that cannot succeed is refused with a reason rather than left
      // sitting: the reason is a document the member can be shown.
      // The Owner's, not the assessor's: `reject_benefit_claim` takes
      // `benefits:approve`, because refusing a claim is the same decision
      // about a member's entitlement that approving one is.
      await asStaff(client, actors.approver, async () => {
        await client.query(`select public.reject_benefit_claim($1, $2)`, [
          claimId,
          'DEMONSTRATION: the admission was shorter than one day on every reading, so the medical benefit does not arise.',
        ]);
      });
      tally.claimsRefused += 1;
      tally.claimsHeld -= 1;

      console.log(`  claim ${scenario.key.padEnd(14)} ${scenario.label} — refused`);
      return;
    }

    console.log(`  claim ${scenario.key.padEnd(14)} ${scenario.label} — held`);
    for (const reason of heldReasons(refusal)) {
      console.log(`                   ${reason}`);
    }
    return;
  }

  tally.claimsAssessed += 1;

  if (scenario.outcome === 'held' || scenario.outcome === 'refused') {
    // The scenario expected a refusal and did not get one. Said out loud
    // rather than swallowed: it means a rule changed.
    console.log(
      `  claim ${scenario.key.padEnd(14)} UNEXPECTED: assessed, though this scenario ` +
        'exists to be held. A rule has changed.',
    );
    return;
  }

  // --- Approve, by somebody who did not assess ---------------------------
  await asStaff(client, actors.approver, async () => {
    await client.query(`select public.approve_benefit_claim($1, null, $2)`, [
      claimId,
      `${marker}: approved at the assessed figure.`,
    ]);
  });
  tally.claimsApproved += 1;

  // --- Pay ---------------------------------------------------------------
  let paymentId: string | null = null;

  await asStaff(client, actors.checker, async () => {
    const paid = await client.query<{ id: string }>(
      `select public.post_benefit_payment($1, 'cash', null, $2::uuid) as id`,
      [claimId, demoKey(`payment:${scenario.key}`)],
    );
    paymentId = paid.rows[0]?.id ?? null;
  });
  tally.claimsPaid += 1;

  if (scenario.outcome === 'reversed' && paymentId !== null) {
    // The Owner's alone, under the authority that already covers reversing
    // any posted movement. A contra entry, never an edit: the original stays
    // on the ledger and the claim becomes terminally reversed.
    await asStaff(client, actors.approver, async () => {
      await client.query(`select public.reverse_benefit_payment($1, $2)`, [
        paymentId,
        'DEMONSTRATION: paid against the wrong claim and reversed the same week.',
      ]);
    });
    tally.paymentsReversed += 1;

    console.log(
      `  claim ${scenario.key.padEnd(14)} ${scenario.label} — paid, then reversed`,
    );
    return;
  }

  console.log(`  claim ${scenario.key.padEnd(14)} ${scenario.label} — paid`);
}

/**
 * The codes a refusal names, one per line.
 *
 * `assess_benefit_claim` raises "Claim BC… cannot be assessed." and then one
 * `code: detail` line per failure, because the eligibility function returns a
 * *set* rather than the first thing wrong — an assessor is told everything
 * that has to change, not made to come back twice. So the seeder prints the
 * codes rather than the first line, which carries no information at all.
 */
/** The first sentence of a refusal, for a one-line report. */
function firstSentence(message: string): string {
  return (message.split('\n')[0] ?? message).slice(0, 120);
}

function heldReasons(message: string): readonly string[] {
  return message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+:/.test(line))
    .map((line) => line.slice(0, 160));
}

// ---------------------------------------------------------------------------
// The meeting scenarios
// ---------------------------------------------------------------------------

/**
 * Four meetings, because four is what it takes to show the whole shape.
 *
 *   two months ago   held, every member marked, minutes written and finalised
 *   last month       held, with an apology, an absence and a correction
 *   this month       cancelled before anybody attended, with a reason
 *   next month       scheduled, so "when is the next one" has an answer
 *
 * One monthly general meeting per branch per calendar month is the one rule
 * the client's documents do state, and the database enforces it — so the
 * cancelled one is a `special` meeting rather than a second general meeting in
 * the same month, which is what the business would actually have to do.
 */
interface MeetingScenario {
  readonly key: string;
  readonly monthsBack: number;
  readonly meetingType: 'monthly_general' | 'special';
  readonly title: string;
  readonly venue: string;
  readonly hour: number;
  readonly outcome: 'held' | 'cancelled' | 'scheduled';
  readonly minutes?: 'finalised' | 'draft';
  /** Mark a register, and how. */
  readonly attendance?: boolean;
  /** Change one answer afterwards, so a correction can be read. */
  readonly correction?: boolean;
  readonly actions?: readonly {
    readonly description: string;
    readonly dueDaysFromNow: number | null;
    readonly status: 'open' | 'in_progress' | 'completed';
  }[];
}

const MEETINGS: readonly MeetingScenario[] = [
  {
    key: 'M-2',
    monthsBack: 2,
    meetingType: 'monthly_general',
    title: 'DEMONSTRATION monthly general meeting',
    venue: 'DEMO branch hall, Kalerwe',
    hour: 14,
    outcome: 'held',
    attendance: true,
    minutes: 'finalised',
    actions: [
      {
        description:
          'DEMONSTRATION: visit the three members who have not saved this month.',
        dueDaysFromNow: -20,
        status: 'completed',
      },
      {
        description: 'DEMONSTRATION: obtain next of kin details from every member.',
        dueDaysFromNow: -5,
        status: 'open',
      },
    ],
  },
  {
    key: 'M-1',
    monthsBack: 1,
    meetingType: 'monthly_general',
    title: 'DEMONSTRATION monthly general meeting',
    venue: 'DEMO branch hall, Kalerwe',
    hour: 14,
    outcome: 'held',
    attendance: true,
    correction: true,
    minutes: 'draft',
    actions: [
      {
        description:
          'DEMONSTRATION: agree what a member who misses three meetings should expect.',
        dueDaysFromNow: 14,
        status: 'in_progress',
      },
    ],
  },
  {
    key: 'M-0',
    monthsBack: 0,
    meetingType: 'special',
    title: 'DEMONSTRATION special meeting on the benefits scheme',
    venue: "DEMO member's compound, Bwaise",
    hour: 16,
    outcome: 'cancelled',
  },
  {
    key: 'M+1',
    monthsBack: -1,
    meetingType: 'monthly_general',
    title: 'DEMONSTRATION monthly general meeting',
    venue: 'DEMO branch hall, Kalerwe',
    hour: 14,
    outcome: 'scheduled',
  },
];

/**
 * How each member is marked, when a register is marked at all.
 *
 * Four answers across six members, because all four are things a register has
 * to be able to say. Nothing in this system attaches a consequence to any of
 * them — the client has not decided there is one — so the demonstration marks
 * them and draws no conclusion.
 */
const ATTENDANCE: Readonly<
  Record<string, 'present' | 'absent' | 'apology' | 'represented'>
> = {
  A: 'present',
  B: 'present',
  C: 'apology',
  D: 'absent',
  E: 'represented',
  F: 'present',
};

async function seedMeeting(
  client: pg.Client,
  scenario: MeetingScenario,
  actors: BenefitActors,
  tally: BenefitTally,
): Promise<void> {
  const branch = await client.query<{ id: string }>(
    `select id from public.branches where status = 'active' order by branch_code limit 1`,
  );

  const branchId = branch.rows[0]?.id;

  if (branchId === undefined) {
    console.log('  meetings        skipped: no active branch on this database');
    return;
  }

  const existing = await client.query<{ id: string; status: string }>(
    `select id, status from public.membership_meetings where title = $1
       and pg_catalog.date_part('month', meeting_date)
         = pg_catalog.date_part('month', (public.business_date() - ($2::int || ' months')::interval))
       and pg_catalog.date_part('year', meeting_date)
         = pg_catalog.date_part('year', (public.business_date() - ($2::int || ' months')::interval))`,
    [scenario.title, scenario.monthsBack],
  );

  if (existing.rows.length > 0) {
    tally.alreadyPresent += 1;
    console.log(
      `  meeting ${scenario.key.padEnd(6)}  already present (${existing.rows[0]!.status})`,
    );
    return;
  }

  let meetingId: string | null = null;

  await asStaff(client, actors.recorder, async () => {
    const scheduled = await client.query<{ id: string }>(
      `select public.schedule_membership_meeting(
                $1, $2, $3, $4,
                ((public.business_date() - ($5::int || ' months')::interval)
                  + ($6::int || ' hours')::interval)::timestamptz,
                $7) as id`,
      [
        branchId,
        scenario.meetingType,
        scenario.title,
        scenario.venue,
        scenario.monthsBack,
        scenario.hour,
        'DEMONSTRATION agenda: savings, the benefits scheme, and next of kin records.',
      ],
    );
    meetingId = scheduled.rows[0]?.id ?? null;
  });

  if (meetingId === null) {
    console.log(`  meeting ${scenario.key.padEnd(6)}  not scheduled`);
    return;
  }

  tally.meetingsScheduled += 1;

  if (scenario.outcome === 'cancelled') {
    await asStaff(client, actors.recorder, async () => {
      await client.query(`select public.cancel_membership_meeting($1, $2)`, [
        meetingId,
        'DEMONSTRATION: called off because the branch hall was unavailable. A meeting people had attended could not be cancelled at all.',
      ]);
    });

    console.log(
      `  meeting ${scenario.key.padEnd(6)}  cancelled, with the reason recorded`,
    );
    return;
  }

  if (scenario.outcome === 'scheduled') {
    console.log(
      `  meeting ${scenario.key.padEnd(6)}  scheduled for next month — the members were notified`,
    );
    return;
  }

  // --- The register ------------------------------------------------------
  //
  // Marking the first member present is what moves the meeting to `held`:
  // the status is derived from the register rather than set by hand, so a
  // meeting with a register and a `scheduled` status cannot exist.
  if (scenario.attendance === true) {
    let markedCount = 0;
    let refused = 0;
    let refusal: string | null = null;

    for (const [letter, answer] of Object.entries(ATTENDANCE)) {
      const member = await findMember(client, letter);
      if (member === null) continue;

      const marked = await tryAsStaff(client, actors.recorder, async () => {
        await client.query(
          `select public.mark_meeting_attendance($1, $2, $3, $4, $5, null)`,
          [
            meetingId,
            member.membershipId,
            answer,
            answer === 'present' ? null : answer === 'apology' ? 'travel' : 'work',
            answer === 'represented'
              ? 'DEMONSTRATION: a relative attended on the member’s behalf.'
              : null,
          ],
        );
      });

      if (marked === null) {
        tally.attendanceMarked += 1;
        markedCount += 1;
      } else {
        refused += 1;
        refusal = refusal ?? firstSentence(marked);
      }
    }

    // Said out loud rather than swallowed. `mark_meeting_attendance` records
    // the members of the meeting's own branch, and `seed-demo.ts` maps some
    // of its members onto existing borrowers who belong to other branches —
    // so a refusal here is the branch rule working, and a seeder that printed
    // only the successes would look as though it had marked everybody.
    console.log(
      `  meeting ${scenario.key.padEnd(6)}  register: ${String(markedCount)} marked` +
        (refused === 0
          ? ''
          : `, ${String(refused)} refused — ${refusal ?? 'no reason given'}`),
    );

    // One answer changed afterwards, so the correction trail can be read. The
    // previous entry is kept in an append-only table with the reason beside
    // it: a register that could be silently rewritten would not be evidence
    // of anything.
    if (scenario.correction === true) {
      const member = await findMember(client, 'D');

      if (member !== null) {
        await tryAsStaff(client, actors.recorder, async () => {
          await client.query(
            `select public.mark_meeting_attendance($1, $2, 'present', null, null, $3)`,
            [
              meetingId,
              member.membershipId,
              'DEMONSTRATION: marked absent in error — the member signed the sheet late.',
            ],
          );
        });
      }
    }
  }

  // --- The minutes -------------------------------------------------------
  if (scenario.minutes !== undefined) {
    await asStaff(client, actors.recorder, async () => {
      await client.query(`select public.record_meeting_minutes($1, $2, null)`, [
        meetingId,
        'DEMONSTRATION MINUTES. The meeting reviewed savings for the month, heard ' +
          'that the benefits scheme is recorded in the system but that four rules ' +
          'remain undecided — the medical ceiling, the number of claims a year, any ' +
          'waiting period and which relatives a condolence benefit covers — and ' +
          'agreed to put all four to the next general meeting. Members were asked to ' +
          'bring next of kin details.',
      ]);
    });

    if (scenario.minutes === 'finalised') {
      await asStaff(client, actors.approver, async () => {
        await client.query(`select public.finalise_meeting_minutes($1)`, [meetingId]);
      });
    }
  }

  // --- The action items --------------------------------------------------
  for (const action of scenario.actions ?? []) {
    let actionId: string | null = null;

    await asStaff(client, actors.recorder, async () => {
      const added = await client.query<{ id: string }>(
        `select public.add_meeting_action_item(
                  $1, $2, null,
                  case when $3::int is null then null
                       else (public.business_date() + $3::int) end) as id`,
        [meetingId, action.description, action.dueDaysFromNow],
      );
      actionId = added.rows[0]?.id ?? null;
    });

    tally.actionsRecorded += 1;

    if (actionId !== null && action.status !== 'open') {
      await asStaff(client, actors.recorder, async () => {
        await client.query(`select public.update_meeting_action_item($1, $2, $3)`, [
          actionId,
          action.status,
          action.status === 'completed'
            ? 'DEMONSTRATION: done, and reported back at the following meeting.'
            : 'DEMONSTRATION: in hand.',
        ]);
      });
    }
  }

  console.log(
    `  meeting ${scenario.key.padEnd(6)}  held, register marked, minutes ${
      scenario.minutes ?? 'not written'
    }`,
  );
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * The payments and the General Ledger must agree, and this proves it.
 *
 * `benefit_payments` is the subledger and `5210`/`5220`/`5230` are the expense
 * accounts, reached by `post_benefit_payment` through `post_journal` — the one
 * posting function every movement in this system goes through. There is no
 * second ledger, and this is the assertion that says so out loud: a seeder
 * that wrote money and did not check would be the quietest possible way to
 * ship an imbalance.
 *
 * Net of reversals on both sides, because a reversal posts a contra entry
 * rather than deleting anything.
 */
async function reconcileBenefits(client: pg.Client): Promise<void> {
  const result = await client.query<{ subledger: string; ledger: string }>(
    `select
       (select coalesce(pg_catalog.sum(
                 case when p.reversed_at is null then p.amount else 0 end), 0)::bigint
          from public.benefit_payments p)::text as subledger,
       (select coalesce(pg_catalog.sum(b.balance), 0)::bigint
          from public.ledger_account_balances b
         where b.code in ('5210', '5220', '5230'))::text as ledger`,
  );

  const row = result.rows[0]!;
  const subledger = BigInt(row.subledger);
  const ledger = BigInt(row.ledger);

  console.log('');
  console.log(
    `  reconciliation  benefit payments UGX ${subledger.toLocaleString('en-UG')}, ` +
      `ledger 5210+5220+5230 UGX ${ledger.toLocaleString('en-UG')}`,
  );

  if (subledger !== ledger) {
    throw new Error(
      `The benefit payment records (${subledger.toString()}) and the benefits expense accounts (${ledger.toString()}) disagree. This is a defect, not a seeding problem — report it.`,
    );
  }

  console.log('                  they agree.');
}

// ---------------------------------------------------------------------------
// Running the whole thing
// ---------------------------------------------------------------------------

/**
 * Every benefit, beneficiary and meeting scenario, in the order they depend
 * on each other.
 *
 * Beneficiaries first, because a bereavement claim cannot be assessed without
 * a verified one — and that dependency is the point rather than an accident of
 * ordering: "do not automatically pay unverified beneficiaries" is the
 * client's instruction, and the seeder has to satisfy it the same way a branch
 * would.
 */
export async function seedBenefitScenarios(
  client: pg.Client,
  actors: BenefitActors,
): Promise<BenefitTally> {
  const tally = emptyBenefitTally();

  await backdateDemonstrationMemberships(client);
  await openCondolenceVocabulary(client);

  console.log('');
  for (const scenario of BENEFICIARIES) {
    await seedBeneficiary(client, scenario, actors, tally);
  }

  // Meetings before claims, and the order is not cosmetic: a bereavement
  // claim moves its member to `deceased` and a suspension scenario suspends
  // another, and `mark_meeting_attendance` records only the members the
  // programme had at the time. Marking a register after the claims had run
  // would show two members refused from meetings held months before either
  // event, which is a false picture of both.
  console.log('');
  for (const scenario of MEETINGS) {
    await seedMeeting(client, scenario, actors, tally);
  }

  console.log('');
  for (const scenario of CLAIMS) {
    await seedClaim(client, scenario, actors, tally);
  }

  await reconcileBenefits(client);

  return tally;
}
