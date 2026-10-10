import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asServiceRole, asUser, deleteTestUsers } from '../helpers/auth-fixtures';
import {
  approveLoan,
  createDraftLoan,
  createLoanScenario,
  narrowLendingRules,
  type LoanScenario,
} from '../helpers/loan-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * Loan snapshots, and the thing that makes them worth having.
 *
 * A snapshot that moves when the live record moves is not a snapshot. Phase 3
 * left this as an explicit obligation: a client changes their phone, a
 * guarantor moves, the Owner raises the rate — and if a loan file read through
 * to the live records, every one of those ordinary edits would silently
 * rewrite what the business claims it was told, in exactly the dispute the
 * file exists for.
 *
 * So the central test here does the four things the specification names:
 * approve a loan, then change the client's details, the guarantor's details
 * and the interest settings — and prove the loan is untouched by all of it.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('loan snapshot suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

describeDb('loan snapshots', () => {
  let scenario: LoanScenario;

  beforeAll(async () => {
    await deleteTestUsers();
    scenario = await createLoanScenario();
  });

  afterAll(async () => {
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  describe('what is captured at approval', () => {
    it('captures the client as they were, in full', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      const live = await queryOne<Record<string, string>>(
        `select client_number, full_name, phone, sex, occupation, village_area,
                district, status
           from public.clients where id = $1`,
        [own.clientId],
      );

      const snapshot = await queryOne<Record<string, string>>(
        `select client_number, full_name, phone, sex, occupation, village_area,
                district, client_status_at_origination as status
           from public.loan_client_snapshots where loan_id = $1`,
        [loanId],
      );

      expect(snapshot).toEqual(live);
    });

    it('captures each guarantor on the application, with their relationship', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      // Phase 13 moved the guarantor evidence onto the loan's own guarantor
      // rows — `loan_guarantors.snapshot_*`, frozen by approval — because
      // half of them are now existing clients, who have no row in
      // `guarantors` and must not be given one. `loan_guarantor_evidence`
      // reads both eras, so the claim is made against the view a reader
      // actually uses.
      const snapshot = await queryOne<{
        full_name: string;
        phone: string;
        relationship_to_client: string;
        had_photograph: boolean;
        subject_kind: string;
        source: string;
      }>(
        `select full_name, phone, relationship_to_client, had_photograph,
                subject_kind, source
           from public.loan_guarantor_evidence where loan_id = $1`,
        [loanId],
      );

      expect(snapshot.relationship_to_client).toBe('Brother');
      expect(snapshot.full_name).toBe('Loan Guarantor');
      expect(snapshot.subject_kind).toBe('external');
      expect(snapshot.source).toBe('loan_guarantors');
      // Whether a photograph was on file, not the path: the object lives in a
      // private bucket under Phase 3's policies, and copying the path would
      // create a second route to it.
      expect(snapshot.had_photograph).toBe(true);
    });

    it('freezes the undertaking each guarantor signed', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      const row = await queryOne<{
        consent_version: string;
        signature_name: string;
        witness_name: string;
        consented_at: string;
      }>(
        `select consent_version, signature_name, witness_name,
                consented_at::text as consented_at
           from public.loan_guarantor_evidence where loan_id = $1`,
        [loanId],
      );

      // The version, not the words. A guarantor cannot be held to terms the
      // business edited afterwards, and the terms row itself refuses to be
      // reworded once signed.
      expect(row.consent_version).toBe('1.0');
      expect(row.signature_name).toBe('Loan Guarantor');
      expect(row.witness_name).toBe('Fixture Witness');
      expect(row.consented_at).not.toBeNull();
    });

    it("captures the application's guarantors, not the client's register", async () => {
      const own = await createLoanScenario();

      await query(
        `insert into public.guarantors
           (id, full_name, sex, date_of_birth, phone, occupation, location)
         values ('77777777-0000-4000-8000-000000000001', 'Detached One', 'male',
                 '1985-01-01', '+256700099501', 'Trader', 'Nakawa')`,
      );
      await query(
        `insert into public.guarantor_identities (guarantor_id, nin)
         values ('77777777-0000-4000-8000-000000000001', 'CM85010001AAAA')`,
      );
      const link = await queryOne<{ id: string }>(
        `insert into public.client_guarantors (client_id, guarantor_id, relationship_to_client)
         values ($1, '77777777-0000-4000-8000-000000000001', 'Cousin') returning id`,
        [own.clientId],
      );
      await query(`update public.client_guarantors set active = false where id = $1`, [
        link.id,
      ]);

      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      const rows = await query<{ full_name: string }>(
        `select full_name from public.loan_guarantor_evidence
          where loan_id = $1 order by full_name`,
        [loanId],
      );

      // Phase 13: the application carries its own guarantors, chosen from the
      // client's *active* associations when the draft was raised. A detached
      // association is not offered and so is not on the loan — and, which is
      // the real change, re-attaching it afterwards would not add it either.
      // What the business relied on is recorded against the loan, not looked
      // up through a register that keeps moving.
      expect(rows.map((row) => row.full_name)).toEqual(['Loan Guarantor']);
    });

    it('captures both identity numbers into the protected table', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      const rows = await query<{ subject_type: string; nin: string }>(
        `select subject_type, nin from public.loan_identity_snapshots
          where loan_id = $1 order by subject_type`,
        [loanId],
      );

      expect(rows.map((row) => row.subject_type)).toEqual(['client', 'guarantor']);
      expect(rows.every((row) => /^C[MF][0-9A-Z]{12}$/.test(row.nin))).toBe(true);
    });

    it('captures the policy in force, which Phase 4 does not otherwise use', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      const row = await queryOne<{
        grace: number;
        penalty: number;
        min_applied: string;
        currency: string;
      }>(
        `select grace_period_days_applied as grace, penalty_rate_bps_applied as penalty,
                min_loan_amount_applied::text as min_applied, currency_code as currency
           from public.loans where id = $1`,
        [loanId],
      );

      const settings = await queryOne<{
        grace_period_days: number;
        penalty_rate_bps: number;
        min_loan_amount: string;
      }>(
        `select grace_period_days, penalty_rate_bps, min_loan_amount::text as min_loan_amount
           from public.business_settings where id = 1`,
      );

      // Unused in Phase 4, and recorded anyway: a borrower in arrears next
      // year is judged against the grace period and penalty rate their loan
      // was issued under, not the ones current then.
      expect(row.grace).toBe(settings.grace_period_days);
      expect(row.penalty).toBe(settings.penalty_rate_bps);
      expect(row.min_applied).toBe(settings.min_loan_amount);
      expect(row.currency).toBe('UGX');
    });
  });

  // =========================================================================
  describe('the snapshot does not move when the world does', () => {
    /**
     * The mandatory test, as the specification sets it out:
     *
     *   1. approve a loan;
     *   2. change the client's phone and location;
     *   3. change the guarantor's phone;
     *   4. change the current interest settings;
     *
     * and the approved loan's snapshot must be unchanged by all of it.
     */
    it('survives changes to the client, the guarantor and the settings', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId, {
        principal: 600_000,
        termMonths: 3,
      });
      await approveLoan(loanId, own);

      // --- What the loan recorded -----------------------------------------
      const before = await queryOne<{
        client_phone: string;
        client_village: string;
        guarantor_phone: string;
        rate: number;
        total_interest: string;
        total_expected: string;
      }>(
        `select cs.phone as client_phone, cs.village_area as client_village,
                gs.phone as guarantor_phone,
                l.interest_rate_bps as rate,
                l.total_interest::text as total_interest,
                l.total_expected_repayment::text as total_expected
           from public.loans l
           join public.loan_client_snapshots cs on cs.loan_id = l.id
           -- Phase 13: the guarantor evidence is on the loan's own guarantor
           -- row now, and loan_guarantor_evidence reads both eras.
           join public.loan_guarantor_evidence gs on gs.loan_id = l.id
          where l.id = $1`,
        [loanId],
      );

      // Hand-checked at 15% on 600,000 over three months.
      expect(before.total_interest).toBe('180000');
      expect(before.total_expected).toBe('780000');

      // --- Now change everything the loan was built from ------------------
      await query(
        `update public.clients
            set phone = '+256700099601', village_area = 'Somewhere Else',
                occupation = 'Different Trade'
          where id = $1`,
        [own.clientId],
      );

      await query(
        `update public.guarantors set phone = '+256700099602', location = 'Moved Away'
          where id = $1`,
        [own.guarantorId],
      );

      // Phase 12: the products move with the rail, and the restore puts both
      // back exactly. The claim is unchanged — the snapshot does not follow
      // any of it.
      const restoreRules = await narrowLendingRules({
        monthlyRateBps: 2_500,
        gracePeriodDays: 14,
        penaltyRateBps: 9_000,
        minLoanAmount: 500_000,
      });

      try {
        const after = await queryOne<typeof before>(
          `select cs.phone as client_phone, cs.village_area as client_village,
                  gs.phone as guarantor_phone,
                  l.interest_rate_bps as rate,
                  l.total_interest::text as total_interest,
                  l.total_expected_repayment::text as total_expected
             from public.loans l
             join public.loan_client_snapshots cs on cs.loan_id = l.id
             join public.loan_guarantor_evidence gs on gs.loan_id = l.id
            where l.id = $1`,
          [loanId],
        );

        // Not one figure moved.
        expect(after).toEqual(before);

        // And specifically: the loan still says 15%, not 25%.
        expect(after.rate).toBe(1_500);
        expect(after.total_expected).toBe('780000');

        // While the live records really did change — otherwise this test
        // would pass by having changed nothing.
        const live = await queryOne<{ phone: string; village_area: string }>(
          `select phone, village_area from public.clients where id = $1`,
          [own.clientId],
        );
        expect(live.phone).toBe('+256700099601');
        expect(live.village_area).toBe('Somewhere Else');
      } finally {
        await restoreRules();
      }
    });

    it('keeps the stored breakdown, even after the rate changes', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId, {
        principal: 200_000,
        termMonths: 2,
      });
      await approveLoan(loanId, own);

      const before = await query<{ interest: string }>(
        `select interest::text as interest from public.loan_periods
          where loan_id = $1 order by period_number`,
        [loanId],
      );

      // Hand-checked: 30,000 then 15,000 — the confirmed Case B figures.
      expect(before.map((row) => row.interest)).toEqual(['30000', '15000']);

      const restoreRate = await narrowLendingRules({ monthlyRateBps: 2_500 });

      try {
        const after = await query<{ interest: string }>(
          `select interest::text as interest from public.loan_periods
            where loan_id = $1 order by period_number`,
          [loanId],
        );

        expect(after).toEqual(before);
      } finally {
        await restoreRate();
      }
    });

    it('survives the client being archived', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      await query(`update public.clients set status = 'archived' where id = $1`, [
        own.clientId,
      ]);

      const row = await queryOne<{ full_name: string; status: string }>(
        `select full_name, client_status_at_origination as status
           from public.loan_client_snapshots where loan_id = $1`,
        [loanId],
      );

      // The snapshot still says the client was active when the loan was made,
      // which is the evidence that eligibility was checked.
      expect(row.status).toBe('active');
      expect(row.full_name).toBe('Loan Borrower');
    });

    it('prevents a guarantor being deleted while a loan references them', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      // `on delete restrict`. The snapshot holds the details, and the
      // reference is what lets somebody follow it back to the live person.
      await expect(
        query(`delete from public.guarantors where id = $1`, [own.guarantorId]),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });

  // =========================================================================
  describe('snapshots cannot be edited', () => {
    let loanId: string;

    beforeAll(async () => {
      loanId = await createDraftLoan(scenario.clientId);
      await approveLoan(loanId, scenario);
    });

    it.each([
      ['loan_client_snapshots', `full_name = 'Rewritten'`],
      ['loan_guarantor_snapshots', `phone = '+256700099999'`],
      ['loan_identity_snapshots', `nin = 'CM00000000AAAA'`],
      ['loan_periods', `interest = 0`],
    ])('refuses an UPDATE on %s, even as service_role', async (table, assignment) => {
      const attempt = await asServiceRole(
        `update public.${table} set ${assignment} where loan_id = $1`,
        [loanId],
      );

      expect(attempt.ok, table).toBe(false);
      expect(attempt.message, table).toMatch(/append-only/i);
    });

    it.each([
      'loan_client_snapshots',
      'loan_guarantor_snapshots',
      'loan_identity_snapshots',
      'loan_periods',
    ])('refuses a DELETE on %s, even as service_role', async (table) => {
      const attempt = await asServiceRole(
        `delete from public.${table} where loan_id = $1`,
        [loanId],
      );

      expect(attempt.ok, table).toBe(false);
    });

    it('refuses an UPDATE whose WHERE clause matches nothing', async () => {
      // Statement-level, so the refusal does not depend on the attacker's
      // WHERE clause being right. A row-level trigger would let an UPDATE
      // against the wrong loan id succeed silently and look like it worked.
      const attempt = await asServiceRole(
        `update public.loan_periods set interest = 0
          where loan_id = '00000000-0000-4000-8000-000000000000'`,
      );

      expect(attempt.ok).toBe(false);
    });

    it('gives no session role INSERT, UPDATE or DELETE on any snapshot table', async () => {
      const rows = await query<{ table_name: string; privilege_type: string }>(
        `select table_name, privilege_type
           from information_schema.role_table_grants
          where table_schema = 'public'
            and grantee in ('anon', 'authenticated')
            and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
            and table_name in ('loan_periods', 'loan_client_snapshots',
                               'loan_guarantor_snapshots', 'loan_identity_snapshots')`,
      );

      // Written exclusively by `approve_loan`, which runs as the table owner.
      // Nobody can write a snapshot by hand, so a stored snapshot is always
      // one the database captured.
      expect(rows).toEqual([]);
    });

    it('refuses a session inserting a forged snapshot', async () => {
      const attempt = await asUser(
        scenario.owner,
        `insert into public.loan_periods
           (loan_id, period_number, opening_principal, principal_portion,
            interest, total_obligation, closing_principal)
         values ($1, 9, 1, 1, 0, 1, 0)`,
        [loanId],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.code).toBe('42501');
    });
  });

  // =========================================================================
  describe('the audit trail records snapshots without their contents', () => {
    it('names the kind and the row count, and no identity data', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      const rows = await query<{ new_values: Record<string, unknown> }>(
        `select new_values from public.audit_log
          where entity_type = 'loan' and entity_id = $1
            and action = 'loan.snapshot_created'`,
        [loanId],
      );

      expect(rows).toHaveLength(4);

      const kinds = rows.map((row) => row.new_values.snapshot).sort();
      expect(kinds).toEqual(['client', 'guarantor', 'identity', 'periods']);

      // `audit:view` is broader than `loans:view_sensitive`. A snapshot in
      // the trail would hand every identity number to anyone who can read the
      // trail, which would undo the separation entirely.
      const serialised = JSON.stringify(rows);
      expect(serialised).not.toMatch(/C[MF][0-9A-Z]{12}/);
      expect(serialised).not.toMatch(/\+256\d{9}/);
      expect(serialised).not.toContain('Loan Borrower');
    });

    it('records the exact terms that became immutable', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId, {
        principal: 600_000,
        termMonths: 3,
      });
      await approveLoan(loanId, own);

      const entry = await queryOne<{ new_values: Record<string, unknown> }>(
        `select new_values from public.audit_log
          where entity_type = 'loan' and entity_id = $1 and action = 'loan.terms_locked'`,
        [loanId],
      );

      // The commercial figures are recorded in full: they are the agreement,
      // and a dispute about what was approved is what the trail is for.
      expect(entry.new_values.principal_amount).toBe(600_000);
      expect(entry.new_values.interest_rate_bps).toBe(1_500);
      expect(entry.new_values.total_interest).toBe(180_000);
      expect(entry.new_values.total_expected_repayment).toBe(780_000);
      expect(entry.new_values.interest_method).toBe('reducing_balance_monthly');
    });

    it('cannot be edited or deleted', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      await expect(
        query(
          `update public.audit_log set action = 'loan.updated' where entity_id = $1`,
          [loanId],
        ),
      ).rejects.toMatchObject({ code: 'P0001' });

      await expect(
        query(`delete from public.audit_log where entity_id = $1`, [loanId]),
      ).rejects.toMatchObject({ code: 'P0001' });
    });
  });
});
