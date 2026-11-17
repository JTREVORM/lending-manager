/**
 * The guarantor concentration ceiling.
 *
 * `business_settings.guarantor_max_active_loans` says, in its own comment,
 * "how many active loans one person may guarantee at once". Before migration
 * `20261119000100` the ceiling was asked in exactly one place — on INSERT into
 * `loan_guarantors` — where it counted loans that were already `active`. A
 * guarantor is attached while the loan is still a *draft*, so the count was
 * almost always zero and the ceiling bound nothing: one person could be
 * attached to three drafts and all three could then be disbursed.
 *
 * The first test is that reproduction. The rest hold the boundary, the
 * approval-time warning and the concurrency in place — a ceiling checked
 * without a lock is a ceiling two transactions can both walk through.
 */
import { describe, expect, it } from 'vitest';

import { getClient, query, queryOne } from '../helpers/db';
import {
  approveLoan,
  createDraftLoan,
  createLoanScenario,
  disburseApprovedLoan,
  disburseLoan,
  fundBranchTill,
  submitLoan,
  tryApproveSubmittedLoan,
} from '../helpers/loan-fixtures';

/** An external guarantor with identification, so only the ceiling can refuse. */
async function createBacker(name: string, phone: string, nin: string): Promise<string> {
  const backer = await queryOne<{ id: string }>(
    `insert into public.guarantors
       (full_name, sex, date_of_birth, phone, occupation, location)
     values ($1, 'male', '1980-01-01', $2, 'Trader', 'Kalerwe')
     returning id`,
    [name, phone],
  );
  await query(
    `insert into public.guarantor_identities (guarantor_id, nin) values ($1, $2)`,
    [backer.id, nin],
  );
  return backer.id;
}

/** A draft application backed by `backerId`, with the undertaking signed. */
async function applicationBackedBy(backerId: string, signature: string) {
  const borrower = await createLoanScenario();
  const loanId = await createDraftLoan(borrower.clientId);
  await query(
    `insert into public.loan_guarantors
       (loan_id, guarantor_id, relationship_to_client,
        consent_terms_id, consent_version, consented_at,
        signature_name, witness_name)
     select $1, $2, 'Friend', t.id, t.version, pg_catalog.now(), $3, 'Fixture Witness'
       from public.guarantor_consent_terms t where t.is_current`,
    [loanId, backerId, signature],
  );
  return { borrower, loanId };
}

async function configuredCeiling(): Promise<number> {
  const row = await queryOne<{ limit: number }>(
    `select guarantor_max_active_loans as limit from public.business_settings where id = 1`,
  );
  return row.limit;
}

async function activeLoansBacked(backerId: string): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `select pg_catalog.count(*)::int as count
       from public.loan_guarantors lg
       join public.loans l on l.id = lg.loan_id
      where lg.guarantor_id = $1 and l.status = 'active'`,
    [backerId],
  );
  return row.count;
}

describe('the guarantor concentration ceiling', () => {
  it('refuses the disbursement that would take a guarantor past the ceiling', async () => {
    // The original defect, end to end, by the exact route that reaches it.
    //
    // Every attachment is made while every loan is still a draft, and every
    // approval is taken before any disbursement. That is the ordinary shape
    // of a morning at a branch, and it is the shape neither of the two
    // earlier checks could see: the attach-time rule counted active loans
    // and found none, and the approval-time rule counts active loans and
    // also finds none, because nothing has been paid out yet.
    //
    // So the ceiling has to hold at the moment a loan becomes active, or it
    // does not hold at all. Before this migration all three were disbursed.
    const ceiling = await configuredCeiling();
    const backer = await createBacker(
      'Ceiling Backer',
      '+256700091001',
      'CM80010191AAAA',
    );

    const applications = [];
    for (let index = 0; index < ceiling + 1; index += 1) {
      const app = await applicationBackedBy(backer, 'Ceiling Backer');
      await submitLoan(app.loanId, app.borrower);
      await approveLoan(app.loanId, app.borrower);
      applications.push(app);
    }

    // Every one of them is approved. Nothing has refused anything yet, and
    // nothing should have: no loan is active, so no ceiling is reached.
    expect(applications).toHaveLength(ceiling + 1);
    expect(await activeLoansBacked(backer)).toBe(0);

    // The first `ceiling` disbursements succeed.
    for (let index = 0; index < ceiling; index += 1) {
      const app = applications[index]!;
      await disburseApprovedLoan(app.loanId, app.borrower);
    }
    expect(await activeLoansBacked(backer)).toBe(ceiling);

    // The one that would make it `ceiling + 1` must be refused.
    const extra = applications[ceiling]!;
    await expect(disburseApprovedLoan(extra.loanId, extra.borrower)).rejects.toThrow(
      /already guarantees .* active loan/i,
    );

    // And the exposure did not move.
    expect(await activeLoansBacked(backer)).toBe(ceiling);
  });

  it('tells the approver which rule will refuse, before they decide', async () => {
    // The advisory half, the same shape as `active_loan_exists`: once the
    // guarantor is already at the ceiling on *active* loans, the approval
    // screen should name the rule rather than let somebody approve a loan
    // that can never be disbursed.
    const ceiling = await configuredCeiling();
    const backer = await createBacker(
      'Advisory Backer',
      '+256700091002',
      'CM80010191BBBB',
    );

    const applications = [];
    for (let index = 0; index < ceiling + 1; index += 1) {
      applications.push(await applicationBackedBy(backer, 'Advisory Backer'));
    }
    for (let index = 0; index < ceiling; index += 1) {
      const app = applications[index]!;
      await disburseLoan(app.loanId, app.borrower);
    }

    const extra = applications[ceiling]!;
    await submitLoan(extra.loanId, extra.borrower);
    const failures = await tryApproveSubmittedLoan(extra.loanId, extra.borrower);
    expect(failures).toContain('guarantor_concentration');
  });

  it('still permits a disbursement up to the ceiling', async () => {
    // The rule must not refuse what the business does permit, or it is just a
    // different wrong answer.
    const ceiling = await configuredCeiling();
    const backer = await createBacker('Within Backer', '+256700091003', 'CM80010191CCCC');

    const applications = [];
    for (let index = 0; index < ceiling; index += 1) {
      applications.push(await applicationBackedBy(backer, 'Within Backer'));
    }
    for (const app of applications) {
      await disburseLoan(app.loanId, app.borrower);
    }

    expect(await activeLoansBacked(backer)).toBe(ceiling);
  });

  it('does not refuse several approvals that resolve to one active loan', async () => {
    // Why the ceiling is not enforced at approval. The business approves more
    // loans for one borrower than that borrower can hold —
    // `max_active_loans_per_client` means only one is ever disbursed — and
    // each of them names the same guarantor. Counting approvals would refuse
    // the third of four applications that were always going to resolve to a
    // single active loan.
    const own = await createLoanScenario();

    for (let index = 0; index < 4; index += 1) {
      const loanId = await createDraftLoan(own.clientId, {
        principal: 400_000 + index,
        termMonths: 1,
      });
      await approveLoan(loanId, own);
    }

    const approved = await queryOne<{ count: number }>(
      `select pg_catalog.count(*)::int as count from public.loans
        where client_id = $1 and status = 'approved'`,
      [own.clientId],
    );
    expect(approved.count).toBe(4);
  });

  it('two concurrent disbursements for one guarantor cannot both pass', async () => {
    // A count taken without a lock is a count two transactions can both read
    // before either writes. The advisory lock is what makes the ceiling true
    // under concurrency rather than usually true.
    const ceiling = await configuredCeiling();
    const backer = await createBacker('Racing Backer', '+256700091004', 'CM80010191DDDD');

    // One below the ceiling, so exactly one of the two racers may succeed.
    const warmUp = [];
    for (let index = 0; index < ceiling - 1; index += 1) {
      warmUp.push(await applicationBackedBy(backer, 'Racing Backer'));
    }
    for (const app of warmUp) {
      await disburseLoan(app.loanId, app.borrower);
    }

    const first = await applicationBackedBy(backer, 'Racing Backer');
    const second = await applicationBackedBy(backer, 'Racing Backer');
    for (const app of [first, second]) {
      await submitLoan(app.loanId, app.borrower);
      await approveLoan(app.loanId, app.borrower);
    }

    // Decision A: both disbursements are raced directly rather than through
    // the fixture that funds, so the branch is given enough for both. The
    // subject here is the guarantor ceiling, not the balance — if the till
    // were short, the second would be refused for the wrong reason and the
    // test would pass without proving anything.
    const branchRow = await queryOne<{ id: string }>(
      `select branch_id as id from public.loans where id = $1`,
      [first.loanId],
    );
    await fundBranchTill(branchRow.id, 50_000_000);

    // Two real connections, impersonating two real officers, so the two
    // disbursements genuinely contend in the database.
    const attempt = async (loanId: string, authUserId: string): Promise<boolean> => {
      const client = await getClient();
      try {
        await client.query('begin');
        await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
          authUserId,
        ]);
        await client.query('set local role authenticated');
        await client.query(`select public.disburse_loan($1)`, [loanId]);
        await client.query('reset role');
        await client.query('commit');
        return true;
      } catch {
        await client.query('rollback').catch(() => undefined);
        return false;
      } finally {
        client.release();
      }
    };

    const outcomes = await Promise.all([
      attempt(first.loanId, first.borrower.owner.authUserId),
      attempt(second.loanId, second.borrower.owner.authUserId),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await activeLoansBacked(backer)).toBe(ceiling);
  });
});
