import { query, queryOne } from './db';
import { createTestUser, type TestUser } from './auth-fixtures';

/**
 * Loan fixtures.
 *
 * A loan needs a surprising amount of context before it can exist: an active
 * client, a guarantor complete enough to pass approval, and an active
 * association between them. Building that by hand in each test file produced
 * copy-and-paste that drifted, so it lives here.
 *
 * Everything is created as the table owner, deliberately bypassing policies.
 * The tests that matter then *attack* the result as a real database role — the
 * fixture's job is to produce a valid starting state, not to prove that
 * creating one is permitted.
 */

/** Distinct phone numbers inside the fixture-cleanup prefix. */
let counter = 0;

function nextPhone(): string {
  counter += 1;
  return `+2567000${String(80_000 + (counter % 19_000)).padStart(5, '0')}`;
}

function nextNin(prefix: 'CM' | 'CF'): string {
  counter += 1;
  return `${prefix}${String(90_000_000 + counter).padStart(8, '0')}ZZZZ`.slice(0, 14);
}

export interface LoanScenario {
  readonly clientId: string;
  readonly guarantorId: string;
  readonly secretary: TestUser;
  readonly manager: TestUser;
  readonly owner: TestUser;
}

/** An active client with one complete guarantor attached. */
export async function createLoanScenario(options?: {
  readonly clientStatus?: string;
  /** Omit the guarantor's identification, to drive the completeness rule. */
  readonly incompleteGuarantor?: boolean;
  /** Attach no guarantor at all. */
  readonly withoutGuarantor?: boolean;
}): Promise<LoanScenario> {
  const secretary = await createTestUser('secretary_treasurer');
  const manager = await createTestUser('manager');
  const owner = await createTestUser('owner_admin');

  const client = await queryOne<{ id: string }>(
    `insert into public.clients
       (full_name, sex, date_of_birth, phone, occupation, village_area, district, status,
        status_reason)
     values ('Loan Borrower', 'female', '1990-01-01', $1, 'Trader', 'Kalerwe', 'Kampala',
             $2, case when $2 in ('suspended','blacklisted') then 'fixture' else null end)
     returning id`,
    [nextPhone(), options?.clientStatus ?? 'active'],
  );

  await query(`insert into public.client_identities (client_id, nin) values ($1, $2)`, [
    client.id,
    nextNin('CF'),
  ]);

  const guarantor = await queryOne<{ id: string }>(
    `insert into public.guarantors
       (full_name, sex, date_of_birth, phone, occupation, location, photo_path)
     values ('Loan Guarantor', 'male', '1985-01-01', $1, 'Teacher', 'Bweyogerere',
             'guarantors/00000000-0000-4000-8000-000000000001/photo/a.jpg')
     returning id`,
    [nextPhone()],
  );

  if (options?.incompleteGuarantor !== true) {
    await query(
      `insert into public.guarantor_identities (guarantor_id, nin) values ($1, $2)`,
      [guarantor.id, nextNin('CM')],
    );
  }

  if (options?.withoutGuarantor !== true) {
    await query(
      `insert into public.client_guarantors (client_id, guarantor_id, relationship_to_client)
       values ($1, $2, 'Brother')`,
      [client.id, guarantor.id],
    );
  }

  return { clientId: client.id, guarantorId: guarantor.id, secretary, manager, owner };
}

/**
 * A loan draft, created as the table owner.
 *
 * The placeholder policy columns mirror what `createLoanAction` writes: they
 * are NOT NULL and a draft has to be savable, and approval overwrites every
 * one of them.
 */
export async function createDraftLoan(
  clientId: string,
  options?: {
    readonly principal?: number;
    readonly termMonths?: number;
    readonly frequency?: string;
    /**
     * Phase 13. Leave the application with no guarantors of its own, to drive
     * the `insufficient_guarantors` rule.
     */
    readonly withoutLoanGuarantors?: boolean;
    /**
     * Phase 13. Attach the guarantors but take no consent, to drive the
     * `guarantor_consent_missing` rule.
     */
    readonly withoutConsent?: boolean;
  },
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.loans
       (client_id, principal_amount, interest_rate_bps, interest_method,
        loan_term_months, repayment_frequency, min_loan_amount_applied,
        grace_period_days_applied, penalty_rate_bps_applied, proposed_disbursement_date)
     values ($1, $2, 1500, 'reducing_balance_monthly', $3, $4, 100000, 3, 5000,
             current_date)
     returning id`,
    [
      clientId,
      options?.principal ?? 600_000,
      options?.termMonths ?? 3,
      options?.frequency ?? 'daily',
    ],
  );

  if (options?.withoutLoanGuarantors !== true) {
    await attachClientGuarantorsToLoan(row.id, clientId, {
      consent: options?.withoutConsent !== true,
    });
  }

  return row.id;
}

/**
 * Attach the client's active guarantors to an application, signed.
 *
 * Phase 13 moved a loan's guarantors onto the loan: approval counts
 * `loan_guarantors`, not the client's register, and refuses an unsigned
 * undertaking. That is what the application screen does — offer the client's
 * known backers, attach the chosen ones, take each consent — so the fixture
 * does the same thing rather than reaching past the rule it is meant to
 * exercise.
 *
 * Written as the table owner, which is what lets it set `consented_at`
 * directly. A real consent is taken through the server action; what these
 * tests need is a loan that *has* one.
 */
export async function attachClientGuarantorsToLoan(
  loanId: string,
  clientId: string,
  options?: { readonly consent?: boolean },
): Promise<void> {
  const signed = options?.consent !== false;

  await query(
    `insert into public.loan_guarantors
       (loan_id, guarantor_id, relationship_to_client,
        consent_terms_id, consent_version, consented_at,
        signature_name, witness_name, witness_phone, consent_place)
     select
       $1, cg.guarantor_id, cg.relationship_to_client,
       case when $2 then t.id end,
       case when $2 then t.version end,
       case when $2 then pg_catalog.now() end,
       case when $2 then g.full_name end,
       case when $2 then 'Fixture Witness' end,
       case when $2 then '+256700000900' end,
       case when $2 then 'Kampala' end
     from public.client_guarantors cg
     join public.guarantors g on g.id = cg.guarantor_id
     left join public.guarantor_consent_terms t on t.is_current
     where cg.client_id = $3 and cg.active
     on conflict do nothing`,
    [loanId, signed, clientId],
  );
}

/**
 * Run statements as a real signed-in user, committed.
 *
 * ## Why the lifecycle fixtures cannot act as the table owner
 *
 * Every lifecycle transition stamps its actor from
 * `public.current_profile_id()`, and the constraints require that actor to be
 * present: `loans_approved_requires_attribution` will not accept an approved
 * loan with no approver, and `loans_submitted_fields_consistent` will not
 * accept a submission time with no submitter.
 *
 * As the table owner there is no session, so `current_profile_id()` is NULL
 * and every one of those transitions is refused. That is the schema working as
 * intended rather than an obstacle: **there is no such thing as a
 * system-performed approval.** Approving a loan and releasing money are human
 * acts, and a financial record that cannot name who performed them is not
 * worth keeping.
 *
 * So these fixtures impersonate a real user, which also makes them a more
 * honest reflection of how the application drives the lifecycle.
 */
async function runAsCommitted(
  user: Pick<TestUser, 'authUserId'>,
  statements: readonly { readonly sql: string; readonly params?: readonly unknown[] }[],
): Promise<void> {
  const { getClient } = await import('./db');
  const client = await getClient();

  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      user.authUserId,
    ]);
    await client.query('set local role authenticated');

    for (const statement of statements) {
      await client.query(statement.sql, [...(statement.params ?? [])]);
    }

    // Back to the owner before committing, so the transaction is not left in
    // a restricted role for the pool's next borrower.
    await client.query('reset role');
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The staff a lifecycle fixture acts as.
 *
 * A `LoanScenario` satisfies this, so the usual call is
 * `approveLoan(loanId, scenario)`. The owner is used for every transition
 * because they hold all eight loan capabilities; a test that cares *which*
 * role may perform a transition drives it as that role directly instead of
 * through these helpers.
 */
export interface LoanActors {
  readonly secretary: Pick<TestUser, 'authUserId'>;
  readonly owner: Pick<TestUser, 'authUserId'>;
}

/** Drive a loan to `pending_approval`. */
export async function submitLoan(loanId: string, actors: LoanActors): Promise<void> {
  await runAsCommitted(actors.secretary, [
    {
      sql: `update public.loans set status = 'pending_approval' where id = $1`,
      params: [loanId],
    },
  ]);
}

/** Drive a loan to `approved`. */
export async function approveLoan(loanId: string, actors: LoanActors): Promise<void> {
  await submitLoan(loanId, actors);
  await runAsCommitted(actors.owner, [
    { sql: `select public.approve_loan($1)`, params: [loanId] },
  ]);
}

/** Drive a loan to `active`. */
export async function disburseLoan(loanId: string, actors: LoanActors): Promise<void> {
  await approveLoan(loanId, actors);
  await runAsCommitted(actors.owner, [
    { sql: `select public.disburse_loan($1)`, params: [loanId] },
  ]);
}

/**
 * Release the money on a loan that is **already** approved.
 *
 * `disburseLoan` drives the whole chain from draft, which re-submits an
 * approved loan and is refused. This is the step on its own, for tests that
 * needed to do something between approval and disbursement.
 */
export async function disburseApprovedLoan(
  loanId: string,
  actors: LoanActors,
): Promise<void> {
  await runAsCommitted(actors.owner, [
    { sql: `select public.disburse_loan($1)`, params: [loanId] },
  ]);
}

/**
 * Refuse an application.
 *
 * Phase 13. Separate from `cancelLoan` because the two are different
 * decisions with different capabilities behind them: a refusal is the
 * approver's and a withdrawal is the Owner's. Takes the actor explicitly,
 * since which role performs it is frequently the point.
 */
export async function rejectLoan(
  loanId: string,
  actor: Pick<TestUser, 'authUserId'>,
  reason: string,
): Promise<void> {
  await runAsCommitted(actor, [
    { sql: `select public.reject_loan($1, $2)`, params: [loanId, reason] },
  ]);
}

/** Cancel a loan. */
export async function cancelLoan(
  loanId: string,
  actors: LoanActors,
  reason: string,
): Promise<void> {
  await runAsCommitted(actors.owner, [
    { sql: `select public.cancel_loan($1, $2)`, params: [loanId, reason] },
  ]);
}

/**
 * Remove every loan fixture.
 *
 * The snapshot tables and `loan_periods` are append-only, enforced by
 * statement-level triggers, so clearing them needs the same documented
 * owner-level exemption `deleteTestUsers` uses for `audit_log` — see the note
 * there. It is safe only because this runs against a throwaway database, as
 * the owner, with no application code involved.
 */
export async function deleteTestLoans(): Promise<void> {
  const GUARDS: readonly { readonly table: string; readonly trigger: string }[] = [
    // Phase 10. The ledger goes first: `journal_entries` references `loans`
    // and `clients` with `on delete restrict`, deliberately — in production
    // nothing deletes a loan that has been posted against, and that is the
    // guarantee worth having. A test database still has to be tearable down,
    // so the journals its fixtures produced are removed here, through the
    // same owner-level trigger exemption every other append-only table in
    // this list uses. `journal_lines` cascade from their entry; their own
    // guard is suspended because a cascade is still a DELETE.
    // Phase 11. The four money-movement documents go before the journals
    // they point at: each holds `journal_entry_id` with `on delete restrict`,
    // so an entry cannot be removed while a document still names it. They
    // also reference `clients` and `loans` the same way, which is the other
    // reason they cannot be left behind.
    { table: 'account_transfers', trigger: 'account_transfers_no_delete' },
    { table: 'expenses', trigger: 'expenses_no_delete' },
    { table: 'other_income', trigger: 'other_income_no_delete' },
    { table: 'account_reconciliations', trigger: 'account_reconciliations_no_delete' },
    { table: 'journal_lines', trigger: 'journal_lines_no_delete' },
    { table: 'journal_entries', trigger: 'journal_entries_no_delete' },
    { table: 'journal_entries', trigger: 'journal_entries_guard_update' },
    // Phase 5. Listed first because the installments reference `loan_periods`,
    // so they have to go before it.
    // Phase 6. The payment ledger is append-only, and its allocations
    // reference `loan_installments` with `on delete restrict` — financial
    // history must not cascade away — so the ledger goes before the schedule.
    { table: 'payment_allocations', trigger: 'payment_allocations_no_delete' },
    { table: 'loan_payments', trigger: 'loan_payments_no_delete' },
    // Phase 7. A penalty is append-only too, and `payment_allocations`
    // references it with `on delete restrict` — a charge's payment history
    // must not cascade away — so the ledger goes before the penalties.
    { table: 'loan_penalties', trigger: 'loan_penalties_no_delete' },
    { table: 'loan_installments', trigger: 'loan_installments_no_delete' },
    { table: 'loan_schedules', trigger: 'loan_schedules_no_delete' },
    { table: 'loan_periods', trigger: 'loan_periods_no_delete' },
    { table: 'loan_client_snapshots', trigger: 'loan_client_snapshots_no_delete' },
    {
      table: 'loan_guarantor_snapshots',
      trigger: 'loan_guarantor_snapshots_no_delete',
    },
    { table: 'loan_identity_snapshots', trigger: 'loan_identity_snapshots_no_delete' },
    // Phase 12. The product terms a loan was approved under, which reference
    // the loan with `on delete restrict` for the same reason every other
    // snapshot does: in production a loan that has been approved is not
    // deleted, and the frozen terms are the evidence of what was agreed.
    { table: 'loan_product_snapshots', trigger: 'loan_product_snapshots_no_delete' },
    // Phase 13. A loan's own guarantors, its product-specific answers, and
    // the guards that make all three evidence rather than working notes: a
    // guarantor cannot be removed from a loan past draft, and the
    // application details cannot be touched at all. Every one of those rules
    // is asserted elsewhere in this directory, which is why suspending them
    // here is an exemption rather than a hole.
    { table: 'loan_guarantors', trigger: 'loan_guarantors_guard_removal' },
    { table: 'loan_documents', trigger: 'loan_documents_guard' },
    { table: 'loan_salary_details', trigger: 'loan_salary_details_guard' },
    { table: 'loan_business_details', trigger: 'loan_business_details_guard' },
  ];

  for (const { table, trigger } of GUARDS) {
    await query(`alter table public.${table} disable trigger ${trigger}`);
  }

  try {
    // The reversal pointer is a self-reference with `on delete restrict`, so
    // an entry and the contra entry that cancels it cannot both go in one
    // statement. Unstamping first is why `journal_entries_guard_update` is
    // in the list above.
    await query(`update public.journal_entries set reversed_by_entry_id = null`);
    await query(`delete from public.account_transfers`);
    await query(`delete from public.expenses`);
    await query(`delete from public.other_income`);
    await query(`delete from public.account_reconciliations`);
    await query(`delete from public.journal_entries`);
    await query(`delete from public.payment_allocations`);
    await query(`delete from public.loan_payments`);
    await query(`delete from public.loan_penalties`);
    await query(`delete from public.loan_installments`);
    await query(`delete from public.loan_schedules`);
    await query(`delete from public.loan_periods`);
    await query(`delete from public.loan_client_snapshots`);
    await query(`delete from public.loan_guarantor_snapshots`);
    await query(`delete from public.loan_identity_snapshots`);
    await query(`delete from public.loan_product_snapshots`);
    // Phase 13. The documents go before the loan and the guarantor rows they
    // reference, both of which they hold with `on delete restrict`.
    await query(`delete from public.loan_documents`);
    await query(`delete from public.loan_guarantors`);
    await query(`delete from public.loan_salary_details`);
    await query(`delete from public.loan_business_details`);
    await query(`delete from public.loans`);
  } finally {
    for (const { table, trigger } of GUARDS) {
      await query(`alter table public.${table} enable trigger ${trigger}`);
    }
  }

  await deleteProbeFrequencies();
}

/**
 * Remove any `*_probe` repayment cadence a test introduced.
 *
 * A few tests need a cadence the business does not offer — a 40-day or
 * 200-day interval — to drive the zero-installment guard and the
 * disbursement-rollback path. Those rows are test artefacts, and leaving them
 * behind breaks the seed guard in `schema.test.ts`, which rightly asserts the
 * reference vocabulary is exactly the three cadences the business offers.
 *
 * Deleting one needs the owner-level trigger exemption, because Phase 5 made
 * repayment frequencies undeletable — see migration 20261005000200. The
 * `_probe` suffix is what keeps this narrow: it can only ever remove a row a
 * test created on purpose, never a seeded cadence.
 */
/**
 * Add a repayment cadence the business does not offer, for a test that needs
 * one the schedule generator will refuse.
 *
 * Phase 12 made this two statements rather than one. A loan product names
 * the cadences it offers, and `approve_loan` refuses one it does not — so a
 * cadence that exists in `repayment_frequencies` but not on the product is
 * rejected by the product check *before* the generator ever sees it, and a
 * test aiming at the generator would get the wrong refusal.
 *
 * Adding it to the default product is also what a business would do: a
 * cadence nobody can sell is not a cadence.
 */
export async function addProbeFrequency(
  key: string,
  label: string,
  intervalDays: number,
  sortOrder: number,
): Promise<void> {
  await query(
    `insert into public.repayment_frequencies (key, label, interval_days, sort_order)
     values ($1, $2, $3, $4)
     on conflict (key) do nothing`,
    [key, label, intervalDays, sortOrder],
  );

  await query(
    `update public.loan_products
        set allowed_repayment_frequencies =
              array(select distinct unnest(allowed_repayment_frequencies || $1::text))
      where is_default`,
    [key],
  );
}

/**
 * Narrow the business's own lending rules, bringing the products with them.
 *
 * ## Why a test cannot simply raise the business minimum any more
 *
 * Phase 12 made the guard rail hold in both directions. A product has to sit
 * inside `business_settings` — `loan_products_within_business_rules` enforces
 * that when a product is saved — and, as of migration 20261012000500,
 * `business_settings` may not be narrowed so far that it strands an active
 * product. Raising the business floor to 200,000 while Quick Loans still
 * lends from 100,000 is refused, by design: the configuration would otherwise
 * say one thing on the Settings screen and another on the product that
 * actually decides.
 *
 * So this does what an Owner would have to do, in the order the rail
 * requires: move the products first, then close the rail behind them. It
 * returns the restore, which goes the other way — open the rail, then put the
 * products back — because that is the only order that is permitted either.
 *
 * The restore is exact rather than reconstructed: every value it puts back
 * was read before anything changed, so a product whose minimum this never
 * touched is left exactly as it was.
 */
export async function narrowLendingRules(changes: {
  readonly minLoanAmount?: number;
  readonly monthlyRateBps?: number;
  readonly gracePeriodDays?: number;
  readonly penaltyRateBps?: number;
}): Promise<() => Promise<void>> {
  const settingsBefore = await queryOne<{
    min_loan_amount: string;
    default_monthly_interest_rate_bps: number;
    grace_period_days: number;
    penalty_rate_bps: number;
  }>(
    `select min_loan_amount::text as min_loan_amount,
            default_monthly_interest_rate_bps, grace_period_days, penalty_rate_bps
       from public.business_settings where id = 1`,
  );

  const productsBefore = await query<{
    id: string;
    min_amount: string;
    min_interest_rate_bps: number;
    default_interest_rate_bps: number;
    max_interest_rate_bps: number;
  }>(
    `select id, min_amount::text as min_amount, min_interest_rate_bps,
            default_interest_rate_bps, max_interest_rate_bps
       from public.loan_products where status = 'active'`,
  );

  if (changes.minLoanAmount !== undefined) {
    await query(
      `update public.loan_products
          set min_amount = greatest(min_amount, $1)
        where status = 'active'`,
      [changes.minLoanAmount],
    );
  }

  if (changes.monthlyRateBps !== undefined) {
    // The ceiling the rail imposes is twice the standing rate, so lowering
    // the standing rate can strand a product's own ceiling.
    await query(
      `update public.loan_products
          set max_interest_rate_bps = least(max_interest_rate_bps, $1 * 2),
              min_interest_rate_bps = least(min_interest_rate_bps, $1 * 2),
              default_interest_rate_bps = least(default_interest_rate_bps, $1 * 2)
        where status = 'active'`,
      [changes.monthlyRateBps],
    );
  }

  await query(
    `update public.business_settings
        set min_loan_amount = coalesce($1, min_loan_amount),
            default_monthly_interest_rate_bps =
              coalesce($2, default_monthly_interest_rate_bps),
            grace_period_days = coalesce($3, grace_period_days),
            penalty_rate_bps = coalesce($4, penalty_rate_bps)
      where id = 1`,
    [
      changes.minLoanAmount ?? null,
      changes.monthlyRateBps ?? null,
      changes.gracePeriodDays ?? null,
      changes.penaltyRateBps ?? null,
    ],
  );

  return async () => {
    await query(
      `update public.business_settings
          set min_loan_amount = $1,
              default_monthly_interest_rate_bps = $2,
              grace_period_days = $3,
              penalty_rate_bps = $4
        where id = 1`,
      [
        settingsBefore.min_loan_amount,
        settingsBefore.default_monthly_interest_rate_bps,
        settingsBefore.grace_period_days,
        settingsBefore.penalty_rate_bps,
      ],
    );

    for (const product of productsBefore) {
      // The ceiling first and the rest with it: every one of these was read
      // before anything moved, so the row goes back to exactly what it was
      // rather than to a reconstruction of it.
      await query(
        `update public.loan_products
            set min_amount = $2,
                max_interest_rate_bps = $3,
                min_interest_rate_bps = $4,
                default_interest_rate_bps = $5
          where id = $1`,
        [
          product.id,
          product.min_amount,
          product.max_interest_rate_bps,
          product.min_interest_rate_bps,
          product.default_interest_rate_bps,
        ],
      );
    }
  };
}

export async function deleteProbeFrequencies(): Promise<void> {
  await query(
    `alter table public.repayment_frequencies disable trigger repayment_frequencies_no_delete`,
  );

  try {
    // Off the product first: a product may not name a cadence that does not
    // exist, and `loan_products_within_business_rules` would refuse the row
    // the moment the cadence was removed from under it.
    await query(
      `update public.loan_products
          set allowed_repayment_frequencies =
                array(select f from unnest(allowed_repayment_frequencies) f
                       where f not like '%\_probe')
        where exists (
          select 1 from unnest(allowed_repayment_frequencies) f where f like '%\_probe'
        )`,
    );
    await query(`delete from public.repayment_frequencies where key like '%\_probe'`);
  } finally {
    await query(
      `alter table public.repayment_frequencies enable trigger repayment_frequencies_no_delete`,
    );
  }
}
