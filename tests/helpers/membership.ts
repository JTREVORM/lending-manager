import { query, queryOne } from './db';

/**
 * Make a pending membership activatable.
 *
 * Polytos Phase 2 added two preconditions to `pending -> active`
 * (ADR-050): the registration fee must have reached the ledger unreversed,
 * and a **verified** acceptance of the member's own policy version must
 * exist. Both are enforced inside `memberships_guard_transition`, so they
 * bind every caller — including the table owner these fixtures run as.
 *
 * The Phase 1 lifecycle tests are about the lifecycle, not about enrolment.
 * They were written when activation needed only the capability, and their own
 * comments said Phase 2 would add these. This is that addition: it satisfies
 * the preconditions the way a real enrolment does — through
 * `record_membership_fee`, which posts a journal, and through an acceptance
 * the guard verifies — so the tests keep asserting what they always asserted
 * without any rule being relaxed to let them.
 *
 * Returns the receipt id, for tests that then want to reverse it.
 */
export async function satisfyActivationPreconditions(
  membershipId: string,
  witnessProfileId: string,
): Promise<string> {
  const receipt = await queryOne<{ id: string }>(
    `select public.record_membership_fee(
              $1,
              (select v.registration_fee
                 from public.membership_policy_versions v
                 join public.memberships m on m.policy_version_id = v.id
                where m.id = $1),
              'cash', null, gen_random_uuid()) as id`,
    [membershipId],
  );

  await query(
    `insert into public.membership_terms_acceptances
       (membership_id, policy_version_id, accepted_at, signature_name,
        consent_method, witness_profile_id)
     select $1, m.policy_version_id, pg_catalog.now(), c.full_name,
            'witnessed_in_branch', $2
       from public.memberships m
       join public.clients c on c.id = m.client_id
      where m.id = $1
     on conflict (membership_id, policy_version_id) do nothing`,
    [membershipId, witnessProfileId],
  );

  return receipt.id;
}

/**
 * Enrol a client and leave the membership `active`, the way the counter does.
 *
 * A convenience over `enrol_member` for fixtures that need a member rather
 * than an enrolment: it goes through the same function the application calls,
 * so a fixture cannot drift into a state the product cannot produce.
 */
export async function enrolMember(
  clientId: string,
  witnessProfileId: string,
  options: {
    readonly initialDeposit?: number;
    readonly paymentMethod?: string;
  } = {},
): Promise<{ readonly membershipId: string; readonly savingsAccountId: string | null }> {
  const row = await queryOne<{ id: string }>(
    `select public.enrol_member(
              $1, $2, null, 'witnessed_in_branch',
              (select full_name from public.clients where id = $1),
              gen_random_uuid(), null, $3, null,
              -- Cast: an uncast NULL for the deposit leaves both its own
              -- parameter and the key expression below untyped.
              $4::bigint, null,
              case when $4::bigint is null then null else gen_random_uuid() end,
              null) as id`,
    [
      clientId,
      options.paymentMethod ?? 'cash',
      witnessProfileId,
      options.initialDeposit ?? null,
    ],
  );

  const account = await query<{ id: string }>(
    `select id from public.savings_accounts where membership_id = $1`,
    [row.id],
  );

  return { membershipId: row.id, savingsAccountId: account[0]?.id ?? null };
}

/**
 * A membership policy version with the savings rules decided, in force today.
 *
 * The seeded version 1.0 is an unapproved draft with all nine rules open, so
 * savings never open under it. Tests that need a working savings module need
 * a version that answers the savings questions — and saying which answers a
 * fixture chose, in the fixture, is better than a migration quietly choosing
 * them for the whole system.
 */
export async function publishTestPolicy(options: {
  readonly version: string;
  /** Days before the business date. Each version needs its own day. */
  readonly effectiveDaysAgo: number;
  readonly qualifyingMonthsConsecutive?: boolean;
  readonly withdrawalRule?: 'allowed' | 'blocked' | 'above_pledged';
  readonly registrationFee?: number;
  readonly monthlyMinimum?: number;
  /**
   * Defaults to `active`. Pass `superseded` for a historical version a test
   * needs to point at: `membership_policy_versions_one_active` allows exactly
   * one version in force, so a fixture that wants a second version has to say
   * which of the two is the live one, and saying it here is clearer than
   * inserting it live and immediately retiring it.
   */
  readonly status?: 'draft' | 'active' | 'superseded';
}): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.membership_policy_versions
       (version, title, effective_from, status, approved_at, approved_by_label,
        registration_fee, monthly_savings_minimum, savings_qualifying_months,
        member_loan_interest_rate_bps, member_loan_max_term_months,
        member_loan_weekly_cadence_max_months, non_member_loan_max_term_months,
        medical_benefit_rate_bps, medical_benefit_min_admission_days,
        family_condolence_benefit, member_bereavement_benefit,
        qualifying_months_consecutive, savings_withdrawal_with_active_loan)
     values ($1, $2, (public.business_date() - $3::int), $8,
             pg_catalog.now(), 'test fixture',
             $4, $5, 6, 500, 5, 2, 3, 500, 1, 100000, 200000, $6, $7)
     returning id`,
    [
      options.version,
      `Test policy ${options.version}`,
      options.effectiveDaysAgo,
      options.registrationFee ?? 5000,
      options.monthlyMinimum ?? 50000,
      options.qualifyingMonthsConsecutive ?? false,
      options.withdrawalRule ?? 'allowed',
      options.status ?? 'active',
    ],
  );
  return row.id;
}

/**
 * Retire a test policy version, around the one-way status rule.
 *
 * A version's status moves `draft -> active -> superseded` and never back —
 * `membership-hardening.test.ts` asserts that in both directions and for the
 * privileged path too. A fixture that needs to rewind between tests is not a
 * counter-example to the rule; it is the documented owner-level exemption,
 * safe here for the same reason `deleteTestUsers` is.
 */
export async function forcePolicyStatus(
  versionId: string,
  status: 'draft' | 'active' | 'superseded',
): Promise<void> {
  await query(
    `alter table public.membership_policy_versions
       disable trigger membership_policy_versions_guard`,
  );
  try {
    await query(
      `update public.membership_policy_versions set status = $2 where id = $1`,
      [versionId, status],
    );
  } finally {
    await query(
      `alter table public.membership_policy_versions
         enable trigger membership_policy_versions_guard`,
    );
  }
}

/**
 * Post a savings deposit on a chosen business date, committed.
 *
 * Contribution months, consecutive runs and "as of" qualification are all
 * dated facts: none of them can be exercised by a test that can only deposit
 * today. `post_savings_deposit` stamps `value_date` from
 * `public.business_date()`, which honours `app.business_now` — but only for a
 * direct owner session, never for an application path. That is the same
 * mechanism the delinquency and payment fixtures use, and it is why the clock
 * is testable without any date column being writable.
 *
 * Committed rather than rolled back, because a deposit's effect has to be
 * visible to the balance, the contribution view and the deposit after it.
 */
export async function depositOn(
  savingsAccountId: string,
  amount: number,
  options: {
    /** A business date, `YYYY-MM-DD`. Defaults to the clock as it stands. */
    readonly on?: string;
    readonly paymentMethod?: string;
    readonly externalReference?: string | null;
    /** Omit to post as the owner, through the trusted path. */
    readonly actor?: { readonly authUserId: string };
  } = {},
): Promise<string> {
  const { getClient } = await import('./db');
  const client = await getClient();

  try {
    await client.query('begin');

    if (options.on !== undefined) {
      // Midday, so the Kampala offset cannot move the date either way.
      await client.query(`select set_config('app.business_now', $1, true)`, [
        `${options.on}T09:00:00Z`,
      ]);
    }

    if (options.actor !== undefined) {
      await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
        options.actor.authUserId,
      ]);
      await client.query('set local role authenticated');
    }

    const posted = await client.query(
      `select public.post_savings_deposit($1, $2, $3, $4, gen_random_uuid()) as id`,
      [
        savingsAccountId,
        amount,
        options.paymentMethod ?? 'cash',
        options.externalReference ?? null,
      ],
    );

    await client.query('reset role');
    await client.query('commit');
    return (posted.rows[0] as { id: string }).id;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
