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

  return row.id;
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
    // Phase 5. Listed first because the installments reference `loan_periods`,
    // so they have to go before it.
    // Phase 6. The payment ledger is append-only, and its allocations
    // reference `loan_installments` with `on delete restrict` — financial
    // history must not cascade away — so the ledger goes before the schedule.
    { table: 'payment_allocations', trigger: 'payment_allocations_no_delete' },
    { table: 'loan_payments', trigger: 'loan_payments_no_delete' },
    { table: 'loan_installments', trigger: 'loan_installments_no_delete' },
    { table: 'loan_schedules', trigger: 'loan_schedules_no_delete' },
    { table: 'loan_periods', trigger: 'loan_periods_no_delete' },
    { table: 'loan_client_snapshots', trigger: 'loan_client_snapshots_no_delete' },
    {
      table: 'loan_guarantor_snapshots',
      trigger: 'loan_guarantor_snapshots_no_delete',
    },
    { table: 'loan_identity_snapshots', trigger: 'loan_identity_snapshots_no_delete' },
  ];

  for (const { table, trigger } of GUARDS) {
    await query(`alter table public.${table} disable trigger ${trigger}`);
  }

  try {
    await query(`delete from public.payment_allocations`);
    await query(`delete from public.loan_payments`);
    await query(`delete from public.loan_installments`);
    await query(`delete from public.loan_schedules`);
    await query(`delete from public.loan_periods`);
    await query(`delete from public.loan_client_snapshots`);
    await query(`delete from public.loan_guarantor_snapshots`);
    await query(`delete from public.loan_identity_snapshots`);
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
export async function deleteProbeFrequencies(): Promise<void> {
  await query(
    `alter table public.repayment_frequencies disable trigger repayment_frequencies_no_delete`,
  );

  try {
    await query(`delete from public.repayment_frequencies where key like '%\_probe'`);
  } finally {
    await query(
      `alter table public.repayment_frequencies enable trigger repayment_frequencies_no_delete`,
    );
  }
}
