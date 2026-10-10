import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asServiceRole,
  asUser,
  asUserScript,
  deleteTestUsers,
} from '../helpers/auth-fixtures';
import {
  approveLoan,
  cancelLoan,
  createDraftLoan,
  createLoanScenario,
  deleteTestLoans,
  disburseLoan,
  rejectLoan,
  submitLoan,
  type LoanScenario,
} from '../helpers/loan-fixtures';
import { closePool, hasDatabase, query, queryOne, skipReason } from '../helpers/db';

/**
 * The loan workflow, the evidence filed with an application, and the two
 * defects Phase 13's screens found underneath them.
 *
 * The first is worth stating plainly because it was invisible from the
 * function that caused it: `reject_loan` checks `loans:approve`, the
 * lifecycle guard underneath it demanded `loans:cancel` for any move to
 * `cancelled`, and the Manager role holds the first and not the second. So
 * the one role the function existed for was the one role it refused — and
 * nothing failed until somebody asked a Manager to refuse an application.
 * The first test here is that Manager.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('loan workflow suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

describeDb('the loan workflow', () => {
  let scenario: LoanScenario;

  beforeAll(async () => {
    await deleteTestUsers();
    scenario = await createLoanScenario();
  });

  afterAll(async () => {
    await deleteTestLoans();
    await deleteTestUsers();
    await closePool();
  });

  // =========================================================================
  describe('refusing an application', () => {
    it('lets a Manager refuse what a Manager may approve', async () => {
      const loanId = await createDraftLoan(scenario.clientId);
      await submitLoan(loanId, scenario);

      const attempt = await asUserScript(scenario.manager, [
        { sql: `select public.reject_loan($1, $2)`, params: [loanId, 'Income unproven'] },
        {
          sql: `select status, closure_kind, cancellation_reason from public.loans where id = $1`,
          params: [loanId],
        },
      ]);

      expect(attempt.ok, attempt.message).toBe(true);
      expect(attempt.rows[0]).toMatchObject({
        status: 'cancelled',
        closure_kind: 'rejected',
        cancellation_reason: 'Income unproven',
      });
    });

    it('still refuses a Secretary/Treasurer, who decides nothing', async () => {
      const loanId = await createDraftLoan(scenario.clientId);
      await submitLoan(loanId, scenario);

      const attempt = await asUser(
        scenario.secretary,
        `select public.reject_loan($1, $2)`,
        [loanId, 'Not my call'],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/loans:approve/i);
    });

    it('keeps a withdrawal on loans:cancel, which a Manager does not hold', async () => {
      // The two decisions end in the same row and are not the same decision.
      // Taking back a loan the business already approved is the Owner's.
      const loanId = await createDraftLoan(scenario.clientId);
      await submitLoan(loanId, scenario);

      const refused = await asUser(
        scenario.manager,
        `select public.cancel_loan($1, $2)`,
        [loanId, 'Borrower changed their mind'],
      );

      expect(refused.ok).toBe(false);
      expect(refused.message).toMatch(/loans:cancel/i);

      const allowed = await asUserScript(scenario.owner, [
        {
          sql: `select public.cancel_loan($1, $2)`,
          params: [loanId, 'Borrower changed their mind'],
        },
        {
          sql: `select status, closure_kind from public.loans where id = $1`,
          params: [loanId],
        },
      ]);

      expect(allowed.ok, allowed.message).toBe(true);
      expect(allowed.rows[0]).toMatchObject({
        status: 'cancelled',
        closure_kind: 'withdrawn',
      });
    });

    it('refuses an application that is not awaiting a decision', async () => {
      const loanId = await createDraftLoan(scenario.clientId);

      const attempt = await asUser(
        scenario.manager,
        `select public.reject_loan($1, $2)`,
        [loanId, 'Too early'],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/awaiting approval/i);
    });

    it('refuses a refusal with no reason', async () => {
      const loanId = await createDraftLoan(scenario.clientId);
      await submitLoan(loanId, scenario);

      const attempt = await asUser(
        scenario.manager,
        `select public.reject_loan($1, $2)`,
        [loanId, '   '],
      );

      expect(attempt.ok).toBe(false);
      expect(attempt.message).toMatch(/requires a reason/i);
    });
  });

  // =========================================================================
  describe('the product a loan was written against', () => {
    it('cannot be changed once the loan leaves draft', async () => {
      // The snapshot says Salary Loan and the loan says Quick Loan is not a
      // disagreement any report can be asked to resolve.
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      const other = await queryOne<{ id: string }>(
        `select p.id from public.loan_products p
          where p.id <> (select l.loan_product_id from public.loans l where l.id = $1)
          limit 1`,
        [loanId],
      );

      await expect(
        query(`update public.loans set loan_product_id = $2 where id = $1`, [
          loanId,
          other.id,
        ]),
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('cannot have its proposed rate rewritten after approval', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      await expect(
        query(`update public.loans set proposed_interest_rate_bps = 1 where id = $1`, [
          loanId,
        ]),
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('refuses even as service_role', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await approveLoan(loanId, own);

      const attempt = await asServiceRole(
        `update public.loans set proposed_interest_rate_bps = 1 where id = $1`,
        [loanId],
      );

      expect(attempt.ok).toBe(false);
    });

    it('is freely editable while the loan is still a draft', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);

      const other = await queryOne<{ id: string }>(
        `select p.id from public.loan_products p
          where p.id <> (select l.loan_product_id from public.loans l where l.id = $1)
            and p.status = 'active'
          limit 1`,
        [loanId],
      );

      await query(`update public.loans set loan_product_id = $2 where id = $1`, [
        loanId,
        other.id,
      ]);

      const row = await queryOne<{ loan_product_id: string }>(
        `select loan_product_id::text as loan_product_id from public.loans where id = $1`,
        [loanId],
      );

      expect(row.loan_product_id).toBe(other.id);
    });
  });

  // =========================================================================
  describe('the evidence filed with an application', () => {
    const path = (loanId: string, kind: string): string =>
      `loans/${loanId}/${kind}/${'a1'.repeat(16)}.pdf`;

    it('accepts a document on a draft', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);

      await query(
        `insert into public.loan_documents
           (loan_id, kind, storage_path, label, content_type, byte_size)
         values ($1, 'payslip', $2, 'September payslip', 'application/pdf', 40000)`,
        [loanId, path(loanId, 'payslip')],
      );

      const row = await queryOne<{ has_payslip: boolean; document_count: string }>(
        `select has_payslip, document_count::text as document_count
           from public.loan_application_profile where loan_id = $1`,
        [loanId],
      );

      expect(row.has_payslip).toBe(true);
      expect(row.document_count).toBe('1');
    });

    it('refuses a path that is not shaped like one', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);

      for (const bad of [
        `/loans/${loanId}/payslip/${'a1'.repeat(16)}.pdf`,
        `loans/../${loanId}/payslip/${'a1'.repeat(16)}.pdf`,
        `payslip.pdf`,
      ]) {
        await expect(
          query(
            `insert into public.loan_documents
               (loan_id, kind, storage_path, content_type, byte_size)
             values ($1, 'payslip', $2, 'application/pdf', 1000)`,
            [loanId, bad],
          ),
          bad,
        ).rejects.toMatchObject({ code: '23514' });
      }
    });

    it('refuses a second document of a named kind', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);

      await query(
        `insert into public.loan_documents
           (loan_id, kind, storage_path, content_type, byte_size)
         values ($1, 'payslip', $2, 'application/pdf', 1000)`,
        [loanId, path(loanId, 'payslip')],
      );

      await expect(
        query(
          `insert into public.loan_documents
             (loan_id, kind, storage_path, content_type, byte_size)
           values ($1, 'payslip', $2, 'application/pdf', 1000)`,
          [loanId, `loans/${loanId}/payslip/${'b2'.repeat(16)}.pdf`],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('accepts any number of supporting documents', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);

      for (const token of ['c3', 'd4', 'e5']) {
        await query(
          `insert into public.loan_documents
             (loan_id, kind, storage_path, content_type, byte_size)
           values ($1, 'supporting', $2, 'image/jpeg', 1000)`,
          [loanId, `loans/${loanId}/supporting/${token.repeat(16)}.jpg`],
        );
      }

      const row = await queryOne<{ count: string }>(
        `select count(*)::text as count from public.loan_documents where loan_id = $1`,
        [loanId],
      );

      expect(row.count).toBe('3');
    });

    it('refuses a guarantor kind with no guarantor, and the reverse', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);

      await expect(
        query(
          `insert into public.loan_documents
             (loan_id, kind, storage_path, content_type, byte_size)
           values ($1, 'guarantor_signature', $2, 'image/png', 1000)`,
          [loanId, path(loanId, 'guarantor_signature')],
        ),
      ).rejects.toMatchObject({ code: '23514' });

      const guarantorRow = await queryOne<{ id: string }>(
        `select id::text as id from public.loan_guarantors where loan_id = $1 limit 1`,
        [loanId],
      );

      await expect(
        query(
          `insert into public.loan_documents
             (loan_id, loan_guarantor_id, kind, storage_path, content_type, byte_size)
           values ($1, $2, 'payslip', $3, 'application/pdf', 1000)`,
          [loanId, guarantorRow.id, path(loanId, 'payslip')],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('refuses a guarantor who is not on this application', async () => {
      const own = await createLoanScenario();
      const other = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      const otherLoan = await createDraftLoan(other.clientId);

      const stranger = await queryOne<{ id: string }>(
        `select id::text as id from public.loan_guarantors where loan_id = $1 limit 1`,
        [otherLoan],
      );

      await expect(
        query(
          `insert into public.loan_documents
             (loan_id, loan_guarantor_id, kind, storage_path, content_type, byte_size)
           values ($1, $2, 'guarantor_signature', $3, 'image/png', 1000)`,
          [loanId, stranger.id, path(loanId, 'guarantor_signature')],
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('freezes from submission, and reopens when the loan is returned', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);

      await query(
        `insert into public.loan_documents
           (loan_id, kind, storage_path, content_type, byte_size)
         values ($1, 'payslip', $2, 'application/pdf', 1000)`,
        [loanId, path(loanId, 'payslip')],
      );

      await submitLoan(loanId, own);

      await expect(
        query(`delete from public.loan_documents where loan_id = $1`, [loanId]),
      ).rejects.toMatchObject({ code: 'P0001' });

      await expect(
        query(
          `insert into public.loan_documents
             (loan_id, kind, storage_path, content_type, byte_size)
           values ($1, 'bank_statement', $2, 'application/pdf', 1000)`,
          [loanId, path(loanId, 'bank_statement')],
        ),
      ).rejects.toMatchObject({ code: 'P0001' });

      // Returned for correction: a reviewer asking for a better scan means
      // exactly this.
      await query(`update public.loans set status = 'draft' where id = $1`, [loanId]);

      await query(`delete from public.loan_documents where loan_id = $1`, [loanId]);
    });

    it('cannot be repointed at another loan', async () => {
      const own = await createLoanScenario();
      const other = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      const otherLoan = await createDraftLoan(other.clientId);

      await query(
        `insert into public.loan_documents
           (loan_id, kind, storage_path, content_type, byte_size)
         values ($1, 'payslip', $2, 'application/pdf', 1000)`,
        [loanId, path(loanId, 'payslip')],
      );

      await expect(
        query(`update public.loan_documents set loan_id = $2 where loan_id = $1`, [
          loanId,
          otherLoan,
        ]),
      ).rejects.toMatchObject({ code: 'P0001' });
    });

    it('refuses an oversized or empty file', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);

      for (const size of [0, 10_485_761]) {
        await expect(
          query(
            `insert into public.loan_documents
               (loan_id, kind, storage_path, content_type, byte_size)
             values ($1, 'supporting', $2, 'application/pdf', $3)`,
            [loanId, `loans/${loanId}/supporting/${'f6'.repeat(16)}.pdf`, size],
          ),
          String(size),
        ).rejects.toMatchObject({ code: '23514' });
      }
    });
  });

  // =========================================================================
  describe('who may file one', () => {
    it('lets a Secretary/Treasurer attach a document to their own draft', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);

      const attempt = await asUser(
        own.secretary,
        `insert into public.loan_documents
           (loan_id, kind, storage_path, content_type, byte_size)
         values ($1, 'supporting', $2, 'image/jpeg', 2000)`,
        [loanId, `loans/${loanId}/supporting/${'0a'.repeat(16)}.jpg`],
      );

      expect(attempt.ok, attempt.message).toBe(true);
    });

    it('refuses a borrower entirely', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);

      await query(
        `insert into public.loan_documents
           (loan_id, kind, storage_path, content_type, byte_size)
         values ($1, 'payslip', $2, 'application/pdf', 1000)`,
        [loanId, `loans/${loanId}/payslip/${'1b'.repeat(16)}.pdf`],
      );

      const borrower = await (async () => {
        const { createTestUser } = await import('../helpers/auth-fixtures');
        return createTestUser('client');
      })();

      const read = await asUser(
        borrower,
        `select count(*)::int as count from public.loan_documents where loan_id = $1`,
        [loanId],
      );

      expect(read.ok).toBe(true);
      expect(read.rows[0]?.count).toBe(0);
    });
  });

  // =========================================================================
  describe('the register the loan module reads', () => {
    it('puts each loan at the stage its lifecycle and collections put it', async () => {
      const drafted = await createLoanScenario();
      const draftLoan = await createDraftLoan(drafted.clientId);

      const pending = await createLoanScenario();
      const pendingLoan = await createDraftLoan(pending.clientId);
      await submitLoan(pendingLoan, pending);

      const approved = await createLoanScenario();
      const approvedLoan = await createDraftLoan(approved.clientId);
      await approveLoan(approvedLoan, approved);

      const live = await createLoanScenario();
      const liveLoan = await createDraftLoan(live.clientId);
      await disburseLoan(liveLoan, live);

      const refused = await createLoanScenario();
      const refusedLoan = await createDraftLoan(refused.clientId);
      await submitLoan(refusedLoan, refused);
      await rejectLoan(refusedLoan, refused.manager, 'Income unproven');

      const stages = new Map(
        (
          await query<{ loan_id: string; workflow_stage: string }>(
            `select loan_id::text as loan_id, workflow_stage
               from public.loan_workflow_register
              where loan_id = any($1::uuid[])`,
            [[draftLoan, pendingLoan, approvedLoan, liveLoan, refusedLoan]],
          )
        ).map((row) => [row.loan_id, row.workflow_stage]),
      );

      expect(stages.get(draftLoan)).toBe('draft');
      expect(stages.get(pendingLoan)).toBe('pending_approval');
      // The intended date is today in the fixture, so an approved loan is
      // already in the queue somebody works through this morning.
      expect(stages.get(approvedLoan)).toBe('awaiting_disbursement');
      expect(stages.get(liveLoan)).toBe('active');
      expect(stages.get(refusedLoan)).toBe('rejected');
    });

    it('separates a refusal from a withdrawal', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await submitLoan(loanId, own);
      await cancelLoan(loanId, own, 'Changed mind');

      const row = await queryOne<{ workflow_stage: string; closure_kind: string }>(
        `select workflow_stage, closure_kind from public.loan_workflow_register
          where loan_id = $1`,
        [loanId],
      );

      expect(row.workflow_stage).toBe('withdrawn');
      expect(row.closure_kind).toBe('withdrawn');
    });

    it('carries the product, the guarantor count and the consent count', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);

      const row = await queryOne<{
        product_code: string;
        product_name: string;
        guarantor_count: string;
        guarantor_consent_count: string;
      }>(
        `select product_code, product_name,
                guarantor_count::text as guarantor_count,
                guarantor_consent_count::text as guarantor_consent_count
           from public.loan_workflow_register where loan_id = $1`,
        [loanId],
      );

      expect(row.product_code).not.toBe('');
      expect(row.guarantor_count).toBe('1');
      expect(row.guarantor_consent_count).toBe('1');
    });

    it('shows a borrower nothing: it is a staff register', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);
      await disburseLoan(loanId, own);

      const { createTestUser } = await import('../helpers/auth-fixtures');
      const borrower = await createTestUser('client');

      const read = await asUser(
        borrower,
        `select count(*)::int as count from public.loan_workflow_register where loan_id = $1`,
        [loanId],
      );

      expect(read.ok).toBe(true);
      expect(read.rows[0]?.count).toBe(0);
    });
  });

  // =========================================================================
  describe('signing an undertaking is not taking on a new guarantee', () => {
    it('lets a guarantor at the concentration limit still sign', async () => {
      // The dead end 13.6 closes. A guarantor is attached while eligible, a
      // second loan they back goes active, and the consent — the only thing
      // standing between the application and a decision — is then refused by
      // the concentration rule. They cannot sign, and they cannot be removed
      // either, because removing a guarantor is itself a change to the
      // application.
      const settings = await queryOne<{ limit: number }>(
        `select guarantor_max_active_loans as limit from public.business_settings where id = 1`,
      );

      const backer = await queryOne<{ id: string }>(
        `insert into public.guarantors
           (full_name, sex, date_of_birth, phone, occupation, location)
         values ('Busy Backer', 'male', '1980-05-05', '+256700079500', 'Trader', 'Kalerwe')
         returning id`,
      );

      await query(
        `insert into public.guarantor_identities (guarantor_id, nin) values ($1, 'CM80050555ZZZZ')`,
        [backer.id],
      );

      // Take them to the limit, on loans that are actually active.
      for (let index = 0; index < settings.limit; index += 1) {
        const borrower = await createLoanScenario();
        const loanId = await createDraftLoan(borrower.clientId);

        await query(
          `insert into public.loan_guarantors
             (loan_id, guarantor_id, relationship_to_client,
              consent_terms_id, consent_version, consented_at,
              signature_name, witness_name)
           select $1, $2, 'Friend', t.id, t.version, pg_catalog.now(),
                  'Busy Backer', 'Fixture Witness'
             from public.guarantor_consent_terms t where t.is_current`,
          [loanId, backer.id],
        );

        await disburseLoan(loanId, borrower);
      }

      // In life the guarantor is attached first and the limit is reached
      // afterwards; here the limit already exists, so the row is written
      // with the attach rule suspended — which is how the backfill wrote the
      // rows this defect was found on. What is under test is the consent
      // that follows, not the attach.
      const applicant = await createLoanScenario();
      const applicationId = await createDraftLoan(applicant.clientId);

      await query(
        `alter table public.loan_guarantors disable trigger loan_guarantors_check_eligibility`,
      );
      await query(
        `insert into public.loan_guarantors (loan_id, guarantor_id, relationship_to_client)
         values ($1, $2, 'Friend')`,
        [applicationId, backer.id],
      );
      await query(
        `alter table public.loan_guarantors enable trigger loan_guarantors_check_eligibility`,
      );

      // The consent is now accepted, where before 13.6 it was refused with
      // "already guarantees N active loans".
      await query(
        `update public.loan_guarantors lg
            set consent_terms_id = t.id,
                consent_version = t.version,
                consented_at = pg_catalog.now(),
                signature_name = 'Busy Backer',
                witness_name = 'Fixture Witness'
           from public.guarantor_consent_terms t
          where t.is_current and lg.loan_id = $1 and lg.guarantor_id = $2`,
        [applicationId, backer.id],
      );

      const row = await queryOne<{ consent_signed: boolean }>(
        `select consent_signed from public.loan_guarantor_register
          where loan_id = $1 and guarantor_id = $2`,
        [applicationId, backer.id],
      );

      expect(row.consent_signed).toBe(true);
    });

    it('still refuses a new guarantee at the limit', async () => {
      // The rule itself is unchanged: what moved is the moment it is asked.
      const settings = await queryOne<{ limit: number }>(
        `select guarantor_max_active_loans as limit from public.business_settings where id = 1`,
      );

      const backer = await queryOne<{ id: string }>(
        `insert into public.guarantors
           (full_name, sex, date_of_birth, phone, occupation, location)
         values ('Full Backer', 'female', '1979-06-06', '+256700079600', 'Trader', 'Kalerwe')
         returning id`,
      );

      await query(
        `insert into public.guarantor_identities (guarantor_id, nin) values ($1, 'CF79060666ZZZZ')`,
        [backer.id],
      );

      for (let index = 0; index < settings.limit; index += 1) {
        const borrower = await createLoanScenario();
        const loanId = await createDraftLoan(borrower.clientId);

        await query(
          `insert into public.loan_guarantors
             (loan_id, guarantor_id, relationship_to_client,
              consent_terms_id, consent_version, consented_at,
              signature_name, witness_name)
           select $1, $2, 'Friend', t.id, t.version, pg_catalog.now(),
                  'Full Backer', 'Fixture Witness'
             from public.guarantor_consent_terms t where t.is_current`,
          [loanId, backer.id],
        );

        await disburseLoan(loanId, borrower);
      }

      const applicant = await createLoanScenario();
      const applicationId = await createDraftLoan(applicant.clientId);

      await expect(
        query(
          `insert into public.loan_guarantors (loan_id, guarantor_id, relationship_to_client)
           values ($1, $2, 'Friend')`,
          [applicationId, backer.id],
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
    });
  });

  // =========================================================================
  describe('who may back an application', () => {
    it('says why somebody cannot, rather than only that they cannot', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);

      const rows = await query<{
        client_id: string;
        eligible: boolean;
        reasons: string[];
      }>(
        `select client_id::text as client_id, eligible, reasons
           from public.guarantor_candidates($1, null)`,
        [loanId],
      );

      const borrower = rows.find((row) => row.client_id === own.clientId);

      expect(borrower).toBeDefined();
      expect(borrower?.eligible).toBe(false);
      expect(borrower?.reasons).toContain('is_borrower');
    });

    it('names a client with no identification on file', async () => {
      const candidate = await queryOne<{ id: string }>(
        `insert into public.clients
           (full_name, sex, date_of_birth, phone, occupation, village_area, district, status)
         values ('Candidate NoId', 'male', '1980-02-02', '+256700079001', 'Mason',
                 'Kawempe', 'Kampala', 'active')
         returning id`,
      );

      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);

      const rows = await query<{ client_id: string; reasons: string[] }>(
        `select client_id::text as client_id, reasons
           from public.guarantor_candidates($1, 'Candidate NoId')`,
        [loanId],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.client_id).toBe(candidate.id);
      expect(rows[0]?.reasons).toContain('no_identification');
    });

    it('names a client who already has an active loan', async () => {
      const busy = await createLoanScenario();
      const busyLoan = await createDraftLoan(busy.clientId);
      await disburseLoan(busyLoan, busy);

      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);

      const rows = await query<{ reasons: string[] }>(
        `select reasons from public.guarantor_candidates($1, null)
          where client_id = $2`,
        [loanId, busy.clientId],
      );

      expect(rows[0]?.reasons).toContain('has_active_loan');
    });

    it('finds a client by number, name or phone', async () => {
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);

      const client = await queryOne<{ client_number: string; phone: string }>(
        `select client_number, phone from public.clients where id = $1`,
        [own.clientId],
      );

      for (const term of [client.client_number, 'Loan Borrower', client.phone]) {
        const rows = await query<{ client_id: string }>(
          `select client_id::text as client_id
             from public.guarantor_candidates($1, $2)`,
          [loanId, term],
        );

        expect(
          rows.some((row) => row.client_id === own.clientId),
          term,
        ).toBe(true);
      }
    });

    it('is advice, not enforcement: the trigger still refuses the write', async () => {
      // The whole point of the split. A screen that only advised would be a
      // suggestion an API caller could ignore.
      const own = await createLoanScenario();
      const loanId = await createDraftLoan(own.clientId);

      await expect(
        query(
          `insert into public.loan_guarantors
             (loan_id, guarantor_client_id, relationship_to_client)
           values ($1, $2, 'Self')`,
          [loanId, own.clientId],
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
    });
  });
});
