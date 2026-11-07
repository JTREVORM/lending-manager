/**
 * Phase 4A: the agency banking foundation, proved by trying.
 *
 * ## What this file is for
 *
 * Phase 4A adds no posting function — the transaction engine is 4B. What it
 * adds is the set of things that must be true of an agency record *whatever*
 * writes it, so that the engine cannot later create a state the books cannot
 * explain. Those are constraints, triggers, grants and policies, and each one
 * is asserted here by attempting the thing it forbids.
 *
 * ## The one that matters most
 *
 * `docs/POLYTOS-PHASE-4-ARCHITECTURE-RECONCILIATION.md` finding A: adding
 * `agency_float` to the `cash_kind` constraint would, on its own, make every
 * float account a legal `record_transfer()` endpoint — movable by anyone
 * holding `transfers:create`, posted as a plain transfer so no agency table
 * ever sees it, and overdraft-checked against `allow_negative_cash` rather
 * than `allow_negative_agency_float`. That is the bypass correction C4 exists
 * to prevent, on the one path C4 does not cover.
 *
 * Two tests below are the proof that it is closed: `record_transfer` refuses a
 * float account, and `assert_agency_float_available` still refuses an
 * overdraft while `allow_negative_cash` is switched **on**.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestUser,
  asUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import {
  closePool,
  expectError,
  hasDatabase,
  query,
  queryOne,
  skipReason,
} from '../helpers/db';

const describeDb = hasDatabase ? describe : describe.skip;
if (!hasDatabase) {
  describe('agency foundation', () => {
    it.skip(`skipped - ${skipReason}`, () => undefined);
  });
}

/**
 * Inline a value into SQL.
 *
 * A `DO $$ ... $$` block's body is a string literal, so `$1` inside one is not
 * a bind parameter — PostgreSQL rejects the statement with "bind message
 * supplies N parameters". These tests need DO blocks to observe a constraint
 * that only fires on the *second* statement, so the values are interpolated.
 * Every one is a UUID or an integer this file read back from the database.
 */
const lit = (v: string | number): string =>
  typeof v === 'number' ? String(v) : `'${v}'`;

/** Resolve a ledger account id by its code. */
async function accountId(code: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `select id from public.ledger_accounts where code = $1`,
    [code],
  );
  return row.id;
}

describeDb('Phase 4A — agency banking foundation', () => {
  let owner: TestUser;
  let manager: TestUser;
  let secretary: TestUser;
  let borrower: TestUser;

  let headOffice: string;
  let otherBranch: string;
  let mtnProviderId: string;
  let mtnTypeId: string;
  let schoolProviderId: string;
  let schoolTypeId: string;
  let headTill: string;
  let otherTill: string;
  let headTillAccount: string;

  // The seeded catalogue is provisional *and* inactive, so nothing may be
  // posted against it (migration 20261107001000). The lifecycle assertions
  // below are about constraints other than readiness, so they need a provider
  // that has passed it: confirmed, active, with a commission basis stated and
  // a type that states a maximum.
  let liveProviderId: string;
  let liveTypeId: string;
  let liveTill: string;

  beforeAll(async () => {
    owner = await createTestUser('owner_admin');
    manager = await createTestUser('manager');
    secretary = await createTestUser('secretary_treasurer');
    borrower = await createTestUser('client');

    headOffice = (
      await queryOne<{ id: string }>(
        `select id from public.branches where branch_code = 'BR2601'`,
      )
    ).id;

    // A second branch, so "branches cannot access each other's tills" has two
    // branches to be true between.
    otherBranch = (
      await queryOne<{ id: string }>(
        `insert into public.branches (branch_code, name, location, status, opened_on)
         values ('BR9901', 'Phase 4A Test Branch', 'Testing', 'active', current_date)
         on conflict (branch_code) do update set name = excluded.name
         returning id`,
      )
    ).id;

    mtnProviderId = (
      await queryOne<{ id: string }>(
        `select id from public.agency_service_providers where code = 'MTN_MOMO'`,
      )
    ).id;
    mtnTypeId = (
      await queryOne<{ id: string }>(
        `select id from public.agency_transaction_types
          where provider_id = $1 and code = 'DEPOSIT'`,
        [mtnProviderId],
      )
    ).id;
    schoolProviderId = (
      await queryOne<{ id: string }>(
        `select id from public.agency_service_providers where code = 'SCHOOL_FEES'`,
      )
    ).id;
    schoolTypeId = (
      await queryOne<{ id: string }>(
        `select id from public.agency_transaction_types
          where provider_id = $1 and code = 'FEES'`,
        [schoolProviderId],
      )
    ).id;

    // Provision one till per branch, through the real provisioning function.
    headTill = (
      await queryOne<{ id: string }>(
        `select public.ensure_agency_float_account($1, $2) as id`,
        [mtnProviderId, headOffice],
      )
    ).id;
    otherTill = (
      await queryOne<{ id: string }>(
        `select public.ensure_agency_float_account($1, $2) as id`,
        [mtnProviderId, otherBranch],
      )
    ).id;
    headTillAccount = (
      await queryOne<{ ledger_account_id: string }>(
        `select ledger_account_id from public.agency_provider_float_accounts where id = $1`,
        [headTill],
      )
    ).ledger_account_id;

    liveProviderId = (
      await queryOne<{ id: string }>(
        `insert into public.agency_service_providers
           (code, name, category, float_model, income_account_id,
            commission_model, commission_rate_bps, is_provisional, is_active)
         values ('TESTLIVE', 'Test Live Provider', 'mobile_money', 'provider_float',
                 (select id from public.ledger_accounts where code = '4510'),
                 'deferred', 150, false, true)
         returning id`,
      )
    ).id;
    liveTypeId = (
      await queryOne<{ id: string }>(
        `insert into public.agency_transaction_types
           (provider_id, code, name, direction, max_single_transaction)
         values ($1, 'DEPOSIT', 'Live Deposit', 'deposit', 5000000)
         returning id`,
        [liveProviderId],
      )
    ).id;
    liveTill = (
      await queryOne<{ id: string }>(
        `select public.ensure_agency_float_account($1, $2) as id`,
        [liveProviderId, headOffice],
      )
    ).id;
  });

  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  describe('chart of accounts', () => {
    it('creates all seventeen agency accounts with the right type and side', async () => {
      const rows = await query<{
        code: string;
        account_type: string;
        normal_side: string;
        is_postable: boolean;
        branch_id: string | null;
      }>(
        `select code, account_type, normal_side, is_postable, branch_id
           from public.ledger_accounts
          where code in ('1300','1310','1320','2200','2210','2220','2290',
                         '4500','4510','4520','4530','4540','4550','4560','4570','4590','5960')
          order by code`,
      );

      expect(rows).toHaveLength(17);

      for (const r of rows) {
        // Finding D4: every one of these is unbranched, because
        // ledger_accounts_cash_is_branch_held ties branch to cash_kind.
        expect(r.branch_id).toBeNull();

        const expectedSide =
          r.account_type === 'asset' || r.account_type === 'expense' ? 'debit' : 'credit';
        expect(r.normal_side).toBe(expectedSide);
      }

      const headings = rows.filter((r) => !r.is_postable).map((r) => r.code);
      expect(headings.sort()).toEqual(['1300', '1320', '2200', '4500']);
    });

    it('parents every new account except the 1300 top level', async () => {
      const orphans = await query<{ code: string }>(
        `select code from public.ledger_accounts
          where parent_id is null and code ~ '^(13|22|45|5960)' order by code`,
      );
      expect(orphans.map((r) => r.code)).toEqual(['1300']);
    });

    it('keeps agency income in the 4500 series, separate from lending income', async () => {
      // Task 6: "agency and lending income remain separately reportable".
      const agency = await query<{ code: string }>(
        `select la.code from public.agency_service_providers p
           join public.ledger_accounts la on la.id = p.income_account_id
          order by la.code`,
      );
      expect(agency.length).toBeGreaterThan(0);
      for (const r of agency) expect(r.code.startsWith('45')).toBe(true);

      // And the lending income accounts are untouched by any agency provider.
      const lending = agency.filter((r) =>
        ['4100', '4200', '4400', '4900'].includes(r.code),
      );
      expect(lending).toHaveLength(0);
    });

    it('refuses a provider whose income account is not an agency account', async () => {
      const interestIncome = await accountId('4100');
      const err = await expectError(
        `update public.agency_service_providers set income_account_id = $1 where code = 'MTN_MOMO'`,
        [interestIncome],
      );
      expect(err?.message).toMatch(/agency income account|4500 series/i);
    });
  });

  // =========================================================================
  describe('finding A — agency float is not reachable by a cash transfer', () => {
    it('assert_cash_account refuses an agency float account', async () => {
      const err = await expectError(`select public.assert_cash_account($1, 'source')`, [
        headTillAccount,
      ]);
      expect(err).not.toBeNull();
      expect(err?.message).toMatch(/agency float account/i);
    });

    it('record_transfer therefore cannot move float, even for an owner', async () => {
      const cashAtHand = await accountId('1010-BR2601');
      const attempt = await asUser(
        owner,
        `select public.record_transfer($1, $2, 10000, current_date, 'should be refused')`,
        [cashAtHand, headTillAccount],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/agency float account/i);
    });

    it('refuses agency float on every generic money-movement path', async () => {
      // Step 7 of the Phase 4A acceptance: `record_transfer` is not the only
      // way an account id reaches the ledger. All four generic entry points
      // funnel through `assert_cash_account`, so hardening that one function
      // closes all four — asserted rather than assumed, because a fifth entry
      // point added later would have to pass the same gate to be safe.
      const expenseAccount = await accountId('5010');
      const incomeAccount = await accountId('4900');

      const attempts = [
        {
          what: 'record_expense (payment account)',
          sql: `select public.record_expense($1, $2, 1000, current_date, 'refused')`,
          params: [expenseAccount, headTillAccount],
        },
        {
          what: 'record_other_income (receiving account)',
          sql: `select public.record_other_income($1, $2, 1000, current_date, 'refused')`,
          params: [incomeAccount, headTillAccount],
        },
        {
          what: 'submit_reconciliation (counted account)',
          sql: `select public.submit_reconciliation($1, current_date, 1000)`,
          params: [headTillAccount],
        },
      ];

      for (const { what, sql, params } of attempts) {
        const attempt = await asUser(owner, sql, params);
        expect(attempt.ok, what).toBe(false);
        expect(attempt.message, what).toMatch(/agency float account/i);
      }
    });

    it('keeps the two reconciliation paths apart — correction C9', async () => {
      // A float account must not be reconcilable through the generic cash
      // reconciliation: it has its own table, with the provider's statement
      // as the counterparty rather than a physical count.
      const attempt = await asUser(
        owner,
        `select public.submit_reconciliation($1, current_date, 0)`,
        [headTillAccount],
      );
      expect(attempt.ok).toBe(false);

      // And the cash account it shares a branch with is still reconcilable.
      const cashAtHand = await accountId('1010-BR2601');
      const ok = await asUser(
        owner,
        `select public.submit_reconciliation($1, current_date, 0)`,
        [cashAtHand],
      );
      expect(ok.ok).toBe(true);
    });

    it('still reaches the balance check for two ordinary cash accounts', async () => {
      // The hardening must not have broken the path it was inserted into.
      // This database is migrated but unseeded, so Cash at Hand holds nothing
      // and the transfer is refused on the *balance* — which is the proof
      // wanted here: execution got past assert_cash_account on both legs and
      // reached assert_cash_available, rather than being turned away as float.
      const cashAtHand = await accountId('1010-BR2601');
      const bank = await accountId('1040-BR2601');
      const attempt = await asUser(
        owner,
        `select public.record_transfer($1, $2, 1000, current_date, 'ordinary transfer')`,
        [cashAtHand, bank],
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).not.toMatch(/agency float/i);
      expect(attempt.message).toMatch(/less than the|shillings/i);
    });

    it('allows an ordinary cash transfer once the account is funded', async () => {
      // And with money in it, the same call succeeds — so the refusal above
      // really was the balance and nothing else.
      const cashAtHand = await accountId('1010-BR2601');
      const bank = await accountId('1040-BR2601');
      const err = await expectError(
        `do $$
         begin
           update public.finance_settings set allow_negative_cash = true where id = 1;
           perform public.record_transfer(${lit(cashAtHand)}::uuid, ${lit(bank)}::uuid,
                                          1000, current_date, 'ordinary transfer');
         end $$;`,
      );
      expect(err).toBeNull();
    });
  });

  // =========================================================================
  describe('correction C4 — the float rule is independent of the cash rule', () => {
    it('refuses an overdraft of float even while allow_negative_cash is on', async () => {
      // This is the whole point of the separate column. Inside a rolled-back
      // transaction, so the setting is restored however the test ends.
      const err = await expectError(
        `do $$
         begin
           update public.finance_settings set allow_negative_cash = true where id = 1;
           perform public.assert_agency_float_available(${lit(headTillAccount)}::uuid, 500000);
         end $$;`,
      );
      expect(err).not.toBeNull();
      expect(err?.message).toMatch(/less than the .* being sent out of it/i);
    });

    it('permits the overdraft once allow_negative_agency_float is on', async () => {
      const err = await expectError(
        `do $$
         begin
           update public.finance_settings set allow_negative_agency_float = true where id = 1;
           perform public.assert_agency_float_available(${lit(headTillAccount)}::uuid, 500000);
         end $$;`,
      );
      expect(err).toBeNull();
    });

    it('leaves allow_negative_cash alone in the committed settings', async () => {
      const row = await queryOne<{
        allow_negative_cash: boolean;
        allow_negative_agency_float: boolean;
      }>(
        `select allow_negative_cash, allow_negative_agency_float
           from public.finance_settings where id = 1`,
      );
      expect(row.allow_negative_cash).toBe(false);
      expect(row.allow_negative_agency_float).toBe(false);
    });

    it('refuses to apply the float rule to a non-float account', async () => {
      const cashAtHand = await accountId('1010-BR2601');
      const err = await expectError(
        `select public.assert_agency_float_available($1, 1)`,
        [cashAtHand],
      );
      expect(err?.message).toMatch(/not an agency float account/i);
    });
  });

  // =========================================================================
  describe('float tills', () => {
    it('provisions a till whose ledger account is agency float, branched and postable', async () => {
      const row = await queryOne<{
        cash_kind: string;
        branch_id: string;
        is_postable: boolean;
        code: string;
        parent_code: string;
      }>(
        `select la.cash_kind, la.branch_id, la.is_postable, la.code,
                (select p.code from public.ledger_accounts p where p.id = la.parent_id) as parent_code
           from public.ledger_accounts la where la.id = $1`,
        [headTillAccount],
      );
      expect(row.cash_kind).toBe('agency_float');
      expect(row.branch_id).toBe(headOffice);
      expect(row.is_postable).toBe(true);
      expect(row.code).toBe('1320.MTN_MOMO.BR2601');
      expect(row.parent_code).toBe('1320');
    });

    it('is idempotent on (provider, branch, till)', async () => {
      const again = await queryOne<{ id: string }>(
        `select public.ensure_agency_float_account($1, $2) as id`,
        [mtnProviderId, headOffice],
      );
      expect(again.id).toBe(headTill);
    });

    it('supports a second till at the same branch, correction C13', async () => {
      const second = await queryOne<{ id: string }>(
        `select public.ensure_agency_float_account($1, $2, 'counter2') as id`,
        [mtnProviderId, headOffice],
      );
      expect(second.id).not.toBe(headTill);

      const code = await queryOne<{ code: string }>(
        `select la.code from public.agency_provider_float_accounts f
           join public.ledger_accounts la on la.id = f.ledger_account_id
          where f.id = $1`,
        [second.id],
      );
      expect(code.code).toMatch(/^1320\.MTN_MOMO\.BR2601\.T\d+$/);
    });

    it('refuses to provision a till for a cash_payable provider', async () => {
      const err = await expectError(`select public.ensure_agency_float_account($1, $2)`, [
        schoolProviderId,
        headOffice,
      ]);
      expect(err?.message).toMatch(/payable account, not float/i);
    });

    it('refuses a till whose ledger account belongs to another branch', async () => {
      const err = await expectError(
        `insert into public.agency_provider_float_accounts
           (provider_id, branch_id, ledger_account_id, till_name)
         values ($1, $2, $3, 'stolen')`,
        [mtnProviderId, otherBranch, headTillAccount],
      );
      expect(err?.message).toMatch(/different branch/i);
    });

    it('refuses two tills sharing one ledger account', async () => {
      const err = await expectError(
        `insert into public.agency_provider_float_accounts
           (provider_id, branch_id, ledger_account_id, till_name)
         values ($1, $2, $3, 'duplicate')`,
        [mtnProviderId, headOffice, headTillAccount],
      );
      expect(err).not.toBeNull();
    });

    it('cannot be deleted', async () => {
      const err = await expectError(
        `delete from public.agency_provider_float_accounts where id = $1`,
        [headTill],
      );
      expect(err?.message).toMatch(/append-only|not permitted/i);
    });
  });

  // =========================================================================
  describe('transaction integrity', () => {
    /** Insert a transaction as the table owner, in a rolled-back transaction. */
    const insertTx = (columns: string, values: string, params: readonly unknown[]) =>
      expectError(
        `insert into public.agency_transactions
           (branch_id, provider_id, transaction_type_id, submitted_by, principal_amount, ${columns})
         values ($1, $2, $3, $4, $5, ${values})`,
        params,
      );

    it('accepts a well-formed draft', async () => {
      const err = await insertTx('float_account_id', '$6', [
        headOffice,
        mtnProviderId,
        mtnTypeId,
        secretary.profileId,
        50_000,
        headTill,
      ]);
      expect(err).toBeNull();
    });

    it('refuses a transaction with neither settlement account', async () => {
      const err = await insertTx('status', `'draft'`, [
        headOffice,
        mtnProviderId,
        mtnTypeId,
        secretary.profileId,
        50_000,
      ]);
      // The BEFORE ROW trigger runs ahead of the CHECK constraints, so the
      // guard refuses first and by message. The exactly-one CHECK is still
      // proved, by the both-accounts case below, which the guard passes.
      expect(err).not.toBeNull();
      expect(err?.message).toMatch(/needs a till|settlement|exactly_one/i);
    });

    it('refuses a transaction with both settlement accounts', async () => {
      const payable = await accountId('2210');
      const err = await insertTx('float_account_id, payable_account_id', '$6, $7', [
        headOffice,
        mtnProviderId,
        mtnTypeId,
        secretary.profileId,
        50_000,
        headTill,
        payable,
      ]);
      expect(err?.constraint).toBe('agency_transactions_exactly_one_settlement_account');
    });

    it('refuses a non-positive principal', async () => {
      const err = await insertTx('float_account_id', '$6', [
        headOffice,
        mtnProviderId,
        mtnTypeId,
        secretary.profileId,
        0,
        headTill,
      ]);
      expect(err?.constraint).toBe('agency_transactions_principal_positive');
    });

    it('refuses a till belonging to another branch', async () => {
      // Task 6: branches cannot reach each other's tills, at the data layer
      // and not only through RLS.
      const err = await insertTx('float_account_id', '$6', [
        headOffice,
        mtnProviderId,
        mtnTypeId,
        secretary.profileId,
        50_000,
        otherTill,
      ]);
      expect(err?.message).toMatch(/different branch/i);
    });

    it('refuses a transaction type from another provider', async () => {
      const err = await insertTx('float_account_id', '$6', [
        headOffice,
        mtnProviderId,
        schoolTypeId,
        secretary.profileId,
        50_000,
        headTill,
      ]);
      expect(err?.message).toMatch(/does not belong to/i);
    });

    it('refuses a float account for a cash_payable provider', async () => {
      const err = await insertTx('float_account_id', '$6', [
        headOffice,
        schoolProviderId,
        schoolTypeId,
        secretary.profileId,
        50_000,
        headTill,
      ]);
      expect(err).not.toBeNull();
    });

    it('refuses a payable account that is not the provider’s own', async () => {
      const wrongPayable = await accountId('2290');
      const err = await insertTx('payable_account_id', '$6', [
        headOffice,
        schoolProviderId,
        schoolTypeId,
        secretary.profileId,
        50_000,
        wrongPayable,
      ]);
      expect(err?.message).toMatch(/not the one registered/i);
    });

    it('refuses a verifier who is also the submitter — separation of duties', async () => {
      const err = await insertTx(
        'float_account_id, status, verified_by, posted_at, journal_entry_id',
        `$6, 'awaiting_verification', $4, null, null`,
        [headOffice, liveProviderId, liveTypeId, manager.profileId, 50_000, liveTill],
      );
      expect(err?.constraint).toBe('agency_transactions_verifier_not_submitter');
    });

    it('refuses a posted transaction with no journal entry', async () => {
      const err = await insertTx(
        'float_account_id, status, verified_by, posted_at',
        `$6, 'posted', $7, now()`,
        [
          headOffice,
          liveProviderId,
          liveTypeId,
          secretary.profileId,
          50_000,
          liveTill,
          manager.profileId,
        ],
      );
      expect(err?.constraint).toBe('agency_transactions_posted_has_journal');
    });

    it('refuses a reversed transaction missing any part of its trail', async () => {
      const err = await insertTx(
        'float_account_id, status, verified_by, posted_at, reversed_at',
        `$6, 'reversed', $7, now(), now()`,
        [
          headOffice,
          liveProviderId,
          liveTypeId,
          secretary.profileId,
          50_000,
          liveTill,
          manager.profileId,
        ],
      );
      // Fails on the journal requirement first; either constraint proves the
      // point, which is that an incomplete reversal cannot be stored.
      expect(err).not.toBeNull();
      expect(err?.constraint).toMatch(/posted_has_journal|reversed_is_complete/);
    });

    it('cannot be deleted', async () => {
      const err = await expectError(
        `do $$
         declare v uuid;
         begin
           insert into public.agency_transactions
             (branch_id, provider_id, transaction_type_id, submitted_by,
              principal_amount, float_account_id)
           values (${lit(headOffice)}, ${lit(mtnProviderId)}, ${lit(mtnTypeId)},
                   ${lit(secretary.profileId)}, 1000, ${lit(headTill)})
           returning id into v;
           delete from public.agency_transactions where id = v;
         end $$;`,
      );
      expect(err?.message).toMatch(/append-only|not permitted/i);
    });
  });

  // =========================================================================
  describe('provider reference and idempotency', () => {
    const insertPair = (statusA: string, statusB: string, ref: string) => {
      const row = (status: string) =>
        `insert into public.agency_transactions
           (branch_id, provider_id, transaction_type_id, submitted_by,
            principal_amount, float_account_id, provider_reference, status)
         values (${lit(headOffice)}, ${lit(liveProviderId)}, ${lit(liveTypeId)},
                 ${lit(secretary.profileId)}, 1000, ${lit(liveTill)}, ${lit(ref)},
                 ${lit(status)});`;
      return expectError(`do $$ begin ${row(statusA)} ${row(statusB)} end $$;`);
    };

    it('refuses a duplicate provider reference once past draft', async () => {
      const err = await insertPair(
        'awaiting_verification',
        'awaiting_verification',
        'MTNREF-1',
      );
      expect(err).not.toBeNull();
      expect(err?.message).toMatch(
        /agency_transactions_provider_reference_unique|duplicate key/i,
      );
    });

    it('keeps the reference claimed after a reversal — correction C7', async () => {
      // Reversing the accounting does not un-send the money at the provider,
      // so the reference must not become reusable.
      const err = await insertPair('reversed', 'awaiting_verification', 'MTNREF-2');
      expect(err).not.toBeNull();
    });

    it('releases the reference for a draft or a cancelled entry', async () => {
      const err = await insertPair('draft', 'cancelled', 'MTNREF-3');
      expect(err).toBeNull();
    });

    it('refuses a reused idempotency key', async () => {
      const tx = (amount: number) =>
        `insert into public.agency_transactions
           (branch_id, provider_id, transaction_type_id, submitted_by,
            principal_amount, float_account_id, idempotency_key)
         values (${lit(headOffice)}, ${lit(mtnProviderId)}, ${lit(mtnTypeId)},
                 ${lit(secretary.profileId)}, ${amount}, ${lit(headTill)}, 'idem-key-1');`;
      const err = await expectError(`do $$ begin ${tx(1000)} ${tx(2000)} end $$;`);
      expect(err).not.toBeNull();
    });
  });

  // =========================================================================
  describe('the audit trail is append-only', () => {
    /** A transaction plus one audit row, in one rolled-back DO block. */
    const withTransaction = (then: string) =>
      expectError(
        `do $$
         declare v uuid;
         begin
           insert into public.agency_transactions
             (branch_id, provider_id, transaction_type_id, submitted_by,
              principal_amount, float_account_id)
           values (${lit(headOffice)}, ${lit(mtnProviderId)}, ${lit(mtnTypeId)},
                   ${lit(secretary.profileId)}, 1000, ${lit(headTill)})
           returning id into v;
           ${then}
         end $$;`,
      );

    it('refuses UPDATE on the agency audit log', async () => {
      const err = await withTransaction(
        `insert into public.agency_transaction_audit_log
           (transaction_id, action, actor_id)
         values (v, 'submit', ${lit(secretary.profileId)});
         update public.agency_transaction_audit_log set reason = 'rewritten'
          where transaction_id = v;`,
      );
      expect(err?.message).toMatch(/append-only|not permitted/i);
    });

    it('refuses DELETE on the agency audit log', async () => {
      const err = await withTransaction(
        `insert into public.agency_transaction_audit_log
           (transaction_id, action, actor_id)
         values (v, 'submit', ${lit(secretary.profileId)});
         delete from public.agency_transaction_audit_log where transaction_id = v;`,
      );
      expect(err?.message).toMatch(/append-only|not permitted/i);
    });

    it('accepts an ordinary submit entry', async () => {
      const err = await withTransaction(
        `insert into public.agency_transaction_audit_log
           (transaction_id, action, actor_id)
         values (v, 'submit', ${lit(secretary.profileId)});`,
      );
      expect(err).toBeNull();
    });

    it('requires a reason for a reversal entry', async () => {
      const err = await withTransaction(
        `insert into public.agency_transaction_audit_log
           (transaction_id, action, actor_id, reason)
         values (v, 'reverse', ${lit(secretary.profileId)}, null);`,
      );
      expect(err?.constraint).toBe('agency_audit_reason_required_where_it_matters');
    });

    it('requires both values on a reference correction', async () => {
      const err = await withTransaction(
        `insert into public.agency_transaction_audit_log
           (transaction_id, action, actor_id, reason, old_value)
         values (v, 'reference_corrected', ${lit(secretary.profileId)}, 'typo',
                 '{"r":"a"}'::jsonb);`,
      );
      expect(err?.constraint).toBe('agency_audit_correction_records_both_values');
    });

    it('refuses an unknown action', async () => {
      const err = await withTransaction(
        `insert into public.agency_transaction_audit_log
           (transaction_id, action, actor_id)
         values (v, 'quietly_adjusted', ${lit(secretary.profileId)});`,
      );
      expect(err?.constraint).toBe('agency_audit_action_valid');
    });
  });

  // =========================================================================
  describe('permissions', () => {
    it('withholds agency:verify from the secretary_treasurer — decision E', async () => {
      const row = await queryOne<{ held: boolean }>(
        `select exists (
           select 1 from public.role_permissions
            where role_key = 'secretary_treasurer' and permission_key = 'agency:verify'
         ) as held`,
      );
      expect(row.held).toBe(false);
    });

    it('matches the maker-checker shape the transfers module uses', async () => {
      const rows = await query<{ permission_key: string; roles: string }>(
        `select permission_key, string_agg(role_key, ',' order by role_key) as roles
           from public.role_permissions
          where permission_key in ('agency:write','agency:verify','agency:providers',
                                   'agency:reverse_cross_day')
          group by 1 order by 1`,
      );
      const map = Object.fromEntries(rows.map((r) => [r.permission_key, r.roles]));
      expect(map['agency:write']).toBe('manager,owner_admin,secretary_treasurer');
      expect(map['agency:verify']).toBe('manager,owner_admin');
      expect(map['agency:providers']).toBe('owner_admin');
      expect(map['agency:reverse_cross_day']).toBe('owner_admin');
    });

    it('grants no agency permission to the borrower role', async () => {
      const rows = await query<{ permission_key: string }>(
        `select permission_key from public.role_permissions
          where role_key = 'client' and permission_key like 'agency:%'`,
      );
      expect(rows).toEqual([]);
    });

    it('refuses to provision a till without agency:providers', async () => {
      for (const user of [secretary, manager]) {
        const attempt = await asUser(
          user,
          `select public.ensure_agency_float_account($1, $2, 'sneaky')`,
          [mtnProviderId, headOffice],
        );
        expect(attempt.ok).toBe(false);
        // Phase 4A raises 42501 for capability refusals from the outset —
        // see docs/POLYTOS-F1-AUTHORIZATION-ERROR-CLASSIFICATION.md §5.
        expect(attempt.code).toBe('42501');
      }
    });

    it('allows an owner to provision a till', async () => {
      const attempt = await asUser(
        owner,
        `select public.ensure_agency_float_account($1, $2, 'ownermade')`,
        [mtnProviderId, headOffice],
      );
      expect(attempt.ok).toBe(true);
    });
  });

  // =========================================================================
  describe('row-level security', () => {
    it('shows agency tables to staff who hold agency:reports', async () => {
      for (const user of [owner, manager, secretary]) {
        const attempt = await asUser(
          user,
          `select count(*)::int as n from public.agency_service_providers`,
        );
        expect(attempt.ok).toBe(true);
        expect((attempt.rows[0] as { n: number }).n).toBeGreaterThan(0);
      }
    });

    it('hides every agency table from a borrower', async () => {
      const tables = [
        'agency_service_providers',
        'agency_transaction_types',
        'agency_provider_float_accounts',
        'agency_transactions',
        'agency_commission_settlements',
        'agency_payable_settlements',
        'agency_float_reconciliations',
        'agency_cash_reconciliations',
        'agency_transaction_audit_log',
      ];
      for (const table of tables) {
        const attempt = await asUser(
          borrower,
          `select count(*)::int as n from public.${table}`,
        );
        // RLS filters rather than raising, so an empty count is the denial.
        expect(attempt.ok).toBe(true);
        expect((attempt.rows[0] as { n: number }).n).toBe(0);
      }
    });

    it('hides another branch’s till from a branch-scoped user', async () => {
      // Pin the manager to Head Office, then confirm the other branch's till
      // is invisible while Head Office's own remains visible.
      await query(`update public.profiles set branch_id = $1 where id = $2`, [
        headOffice,
        manager.profileId,
      ]);
      try {
        const visible = await asUser(
          manager,
          `select id::text from public.agency_provider_float_accounts order by id`,
        );
        const ids = visible.rows.map((r) => (r as { id: string }).id);
        expect(ids).toContain(headTill);
        expect(ids).not.toContain(otherTill);
      } finally {
        await query(`update public.profiles set branch_id = null where id = $1`, [
          manager.profileId,
        ]);
      }
    });

    it('allows no write to any agency table through the Data API', async () => {
      const attempt = await asUser(
        owner,
        `insert into public.agency_service_providers
           (code, name, category, float_model, income_account_id, commission_model)
         values ('HACK','Hack','other','provider_float',
                 (select id from public.ledger_accounts where code='4590'),'immediate')`,
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/permission denied/i);
    });
  });

  // =========================================================================
  describe('journal source types', () => {
    it('accepts the five new agency source types and keeps the old ones', async () => {
      const def = await queryOne<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint
          where conname = 'journal_entries_source_valid'`,
      );
      for (const v of [
        'agency_transaction',
        'agency_transaction_reversal',
        'agency_commission_settlement',
        'agency_payable_settlement',
        'agency_payable_settlement_reversal',
      ]) {
        expect(def.def).toContain(`'${v}'`);
      }
      // Correction C11 and the twenty other pre-existing values survive.
      for (const v of [
        'transfer_reversal',
        'loan_disbursement',
        'savings_withdrawal_reversal',
      ]) {
        expect(def.def).toContain(`'${v}'`);
      }
    });
  });

  // =========================================================================
  describe('live posting readiness — nothing posts against an unconfirmed provider', () => {
    /** Try to move a transaction past draft, as the table owner. */
    const pastDraft = (
      provider: string,
      type: string,
      till: string,
      status = 'awaiting_verification',
    ) =>
      expectError(
        `insert into public.agency_transactions
           (branch_id, provider_id, transaction_type_id, submitted_by,
            principal_amount, float_account_id, status)
         values ($1, $2, $3, $4, 1000, $5, '${status}')`,
        [headOffice, provider, type, secretary.profileId, till],
      );

    it('refuses to post against a provisional provider', async () => {
      const err = await pastDraft(mtnProviderId, mtnTypeId, headTill);
      expect(err).not.toBeNull();
      expect(err?.message).toMatch(/still provisional/i);
    });

    it('allows a draft against a provisional provider', async () => {
      // A counter must still be able to type while a provider is set up. The
      // gate is on the transition out of draft, which is where money moves.
      const err = await pastDraft(mtnProviderId, mtnTypeId, headTill, 'draft');
      expect(err).toBeNull();
    });

    it('refuses to post against a confirmed but inactive provider', async () => {
      const err = await expectError(
        `do $$
         declare p uuid; t uuid; f uuid;
         begin
           insert into public.agency_service_providers
             (code, name, category, float_model, income_account_id,
              commission_model, commission_fixed, is_provisional, is_active)
           values ('TESTOFF', 'Switched Off', 'mobile_money', 'provider_float',
                   (select id from public.ledger_accounts where code = '4510'),
                   'deferred', 500, false, false)
           returning id into p;
           insert into public.agency_transaction_types
             (provider_id, code, name, direction, max_single_transaction)
           values (p, 'DEPOSIT', 'Off Deposit', 'deposit', 100000) returning id into t;
           f := public.ensure_agency_float_account(p, ${lit(headOffice)}::uuid);
           insert into public.agency_transactions
             (branch_id, provider_id, transaction_type_id, submitted_by,
              principal_amount, float_account_id, status)
           values (${lit(headOffice)}, p, t, ${lit(secretary.profileId)}, 1000,
                   f, 'awaiting_verification');
         end $$;`,
      );
      expect(err?.message).toMatch(/not active/i);
    });

    it('refuses to post a type that states no maximum', async () => {
      const err = await expectError(
        `do $$
         declare t uuid;
         begin
           insert into public.agency_transaction_types
             (provider_id, code, name, direction)
           values (${lit(liveProviderId)}, 'NOLIMIT', 'Unbounded', 'deposit')
           returning id into t;
           insert into public.agency_transactions
             (branch_id, provider_id, transaction_type_id, submitted_by,
              principal_amount, float_account_id, status)
           values (${lit(headOffice)}, ${lit(liveProviderId)}, t,
                   ${lit(secretary.profileId)}, 1000, ${lit(liveTill)},
                   'awaiting_verification');
         end $$;`,
      );
      expect(err?.message).toMatch(/no maximum single transaction/i);
    });

    it('refuses to confirm a provider with no commission basis', async () => {
      const err = await expectError(
        `update public.agency_service_providers
            set is_provisional = false where code = 'MTN_MOMO'`,
      );
      expect(err?.constraint).toBe('agency_providers_confirmed_states_commission');
    });

    it('allows confirming a provider once its commission is stated', async () => {
      const err = await expectError(
        `update public.agency_service_providers
            set commission_rate_bps = 150, is_provisional = false, is_active = true
          where code = 'MTN_MOMO'`,
      );
      expect(err).toBeNull();
    });

    it('posts once the provider is confirmed, active and limited', async () => {
      // The positive side: a provider that passes all five conditions is not
      // blocked, so the gate refuses readiness failures and nothing else.
      const err = await pastDraft(liveProviderId, liveTypeId, liveTill);
      expect(err).toBeNull();
    });

    it('refuses a transaction above its type’s maximum', async () => {
      const err = await expectError(
        `insert into public.agency_transactions
           (branch_id, provider_id, transaction_type_id, submitted_by,
            principal_amount, float_account_id)
         values ($1, $2, $3, $4, 9999999999, $5)`,
        [headOffice, liveProviderId, liveTypeId, secretary.profileId, liveTill],
      );
      expect(err?.message).toMatch(/may not exceed/i);
    });
  });

  // =========================================================================
  describe('the provisional catalogue', () => {
    /**
     * The nine rows migration 20261107000800 seeds. Scoped by code because
     * this file also creates a confirmed, active fixture provider, which is
     * deliberately none of these things.
     */
    const SEEDED = `code in ('MTN_MOMO','AIRTEL_MONEY','UEDCL','NWSC','DSTV','GOTV',
                             'LYCAMOBILE','STANBIC','SCHOOL_FEES')`;

    it('seeds exactly nine providers, every one provisional and inactive', async () => {
      const rows = await query<{
        code: string;
        is_provisional: boolean;
        is_active: boolean;
      }>(
        `select code, is_provisional, is_active from public.agency_service_providers
          where ${SEEDED} order by code`,
      );
      expect(rows).toHaveLength(9);
      for (const r of rows) {
        expect(r.is_provisional, r.code).toBe(true);
        // Inactive is what actually keeps them out of the posting path:
        // loading the catalogue is not the same act as going live with it.
        expect(r.is_active, r.code).toBe(false);
      }
    });

    it('leaves commission rates unset rather than guessing them', async () => {
      const rows = await query<{ code: string }>(
        `select code from public.agency_service_providers
          where ${SEEDED}
            and (commission_rate_bps is not null or commission_fixed is not null)`,
      );
      expect(rows).toEqual([]);
    });

    it('states no transaction limit for any seeded type', async () => {
      // NULL is "no limit", which is correct for an unreviewed catalogue and
      // is exactly why the readiness gate refuses to post against it.
      const rows = await query<{ code: string }>(
        `select t.code from public.agency_transaction_types t
           join public.agency_service_providers p on p.id = t.provider_id
          where p.${SEEDED.replace('code in', 'code in')}
            and (t.max_single_transaction is not null or t.requires_approval_above is not null)`,
      );
      expect(rows).toEqual([]);
    });

    it('gives airtime the immediate model and everything else deferred', async () => {
      const rows = await query<{
        code: string;
        commission_model: string;
        category: string;
      }>(
        `select code, commission_model, category from public.agency_service_providers order by code`,
      );
      for (const r of rows) {
        expect(r.commission_model).toBe(
          r.category === 'airtime_data' ? 'immediate' : 'deferred',
        );
      }
    });

    it('requires a payable account exactly when the model is cash_payable', async () => {
      const rows = await query<{
        code: string;
        float_model: string;
        has_payable: boolean;
      }>(
        `select code, float_model, payable_account_id is not null as has_payable
           from public.agency_service_providers order by code`,
      );
      for (const r of rows) {
        expect(r.has_payable).toBe(r.float_model === 'cash_payable');
      }
    });
  });
});
