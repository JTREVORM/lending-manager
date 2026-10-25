import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asUser,
  createTestUser,
  deleteTestUsers,
  type TestUser,
} from '../helpers/auth-fixtures';
import {
  closePool,
  expectError,
  getClient,
  hasDatabase,
  query,
  queryOne,
  skipReason,
} from '../helpers/db';
import {
  depositOn,
  enrolMember,
  forcePolicyStatus,
  publishTestPolicy,
} from '../helpers/membership';

/**
 * Savings: the subledger, the liability, the contribution engine and the
 * withdrawal lifecycle.
 *
 * ## What is actually at stake
 *
 * A savings deposit is the one movement in this system where getting the
 * *direction* wrong is invisible until it is catastrophic. A deposit credited
 * to income looks right on every screen — the balance is there, the statement
 * reads correctly, the member is happy — and it overstates the year's surplus
 * by the entire savings book. In Phase 5 that surplus is shared out, so the
 * business would pay a profit share out of its members' own deposits and
 * discover it only when it could not return them. The first group of tests
 * below reads the journal rather than the balance for exactly that reason.
 *
 * ## The three invariants
 *
 *   1. **The subledger and the ledger agree.** `sum(signed_amount)` over
 *      `savings_transactions` equals the `2100 Member Savings` balance, always,
 *      including after reversals. Asserted at the end of every lifecycle test,
 *      not once at the bottom of the file.
 *   2. **The balance never goes negative.** Checked under a row lock at
 *      request, re-checked under the lock at payment, and checked again before
 *      a deposit can be reversed.
 *   3. **Nothing is edited.** A correction is a new row with its own journal.
 *      `savings_transactions` has no UPDATE or DELETE grant and a statement
 *      trigger behind that, so the claim is tested both ways.
 *
 * ## Dates
 *
 * Contribution months and qualification are dated facts, so most of this file
 * deposits on chosen business dates through `depositOn`. That goes through
 * `app.business_now`, which the database honours only for a direct owner
 * session — no application path can reach it. The dates are relative to a
 * fixed anchor computed once in `beforeAll`, so the suite does not change
 * meaning on the first of a month.
 */
const describeDb = hasDatabase ? describe : describe.skip;

if (!hasDatabase) {
  describe('savings suite', () => {
    it.skip(`skipped — ${skipReason}`, () => undefined);
  });
}

interface Fixtures {
  owner: TestUser;
  manager: TestUser;
  secretary: TestUser;
  /** A second manager, so a decision can come from someone else. */
  approver: TestUser;
  borrower: TestUser;
  policyId: string;
  /** The first day of the current month in the business timezone. */
  thisMonth: string;
}

let fx: Fixtures;
let clientSeq = 0;

/** The first day of the month `back` months before the business date. */
function monthStart(anchor: string, back: number): string {
  const [year, month] = anchor.split('-').map(Number) as [number, number];
  const shifted = new Date(Date.UTC(year, month - 1 - back, 1));
  return shifted.toISOString().slice(0, 10);
}

/** A day inside the month `back` months before the business date. */
function dayInMonth(anchor: string, back: number, day: number): string {
  const first = monthStart(anchor, back);
  return `${first.slice(0, 8)}${String(day).padStart(2, '0')}`;
}

async function makeClient(name: string, phone: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into public.clients
       (full_name, sex, date_of_birth, phone, occupation, village_area, district)
     values ($1, 'male', '1988-06-01', $2, 'Carpenter', 'Bwaise', 'Kampala')
     returning id`,
    [name, phone],
  );
  return row.id;
}

/** An active member with an open savings account and nothing in it. */
async function saver(): Promise<{
  clientId: string;
  membershipId: string;
  savingsAccountId: string;
}> {
  clientSeq += 1;
  const clientId = await makeClient(
    `Saver ${clientSeq}`,
    `+2567003${String(10000 + clientSeq).slice(-5)}`,
  );
  const { membershipId, savingsAccountId } = await enrolMember(
    clientId,
    fx.manager.profileId,
  );

  if (savingsAccountId === null) {
    throw new Error('enrol_member opened no savings account');
  }

  return { clientId, membershipId, savingsAccountId };
}

/** The `2100 Member Savings` ledger balance, as the ledger reads it. */
async function liabilityBalance(): Promise<number> {
  const row = await queryOne<{ balance: string }>(
    `select balance from public.ledger_account_balances where code = '2100'`,
  );
  return Number(row.balance);
}

/** The subledger's own total. Invariant 1 says these two are equal. */
async function subledgerTotal(): Promise<number> {
  const row = await queryOne<{ total: string }>(
    `select coalesce(sum(signed_amount), 0)::bigint as total
       from public.savings_transactions`,
  );
  return Number(row.total);
}

async function balanceOf(savingsAccountId: string): Promise<number> {
  const row = await queryOne<{ balance: string }>(
    `select balance from public.member_savings_balances where savings_account_id = $1`,
    [savingsAccountId],
  );
  return Number(row.balance);
}

beforeAll(async () => {
  if (!hasDatabase) return;

  const [owner, manager, secretary, approver, borrower] = await Promise.all([
    createTestUser('owner_admin'),
    createTestUser('manager'),
    createTestUser('secretary_treasurer'),
    createTestUser('manager'),
    createTestUser('client'),
  ]);

  const policyId = await publishTestPolicy({
    version: '7.1',
    effectiveDaysAgo: 400,
    qualifyingMonthsConsecutive: false,
    withdrawalRule: 'allowed',
  });

  const today = await queryOne<{ d: string }>(
    `select pg_catalog.to_char(public.business_date(), 'YYYY-MM-DD') as d`,
  );

  fx = {
    owner,
    manager,
    secretary,
    approver,
    borrower,
    policyId,
    thisMonth: today.d,
  };
});

afterAll(async () => {
  if (!hasDatabase) return;

  await deleteTestUsers();
  await forcePolicyStatus(fx.policyId, 'superseded');
  await query(
    `alter table public.membership_policy_versions
       disable trigger membership_policy_versions_no_delete`,
  );
  await query(
    `alter table public.membership_policy_versions
       disable trigger audit_membership_policy_change`,
  );
  try {
    await query(`delete from public.membership_policy_versions where version = '7.1'`);
  } finally {
    await query(
      `alter table public.membership_policy_versions
         enable trigger audit_membership_policy_change`,
    );
    await query(
      `alter table public.membership_policy_versions
         enable trigger membership_policy_versions_no_delete`,
    );
  }
  await closePool();
});

// ===========================================================================
describeDb('a deposit is a liability, and the ledger says so', () => {
  it('credits 2100 Member Savings and debits cash, and touches no income account', async () => {
    const { savingsAccountId } = await saver();

    const txnId = await depositOn(savingsAccountId, 60_000);

    const lines = await query<{
      code: string;
      account_type: string;
      debit: string;
      credit: string;
    }>(
      `select a.code, a.account_type, l.debit, l.credit
         from public.savings_transactions t
         join public.journal_lines l on l.entry_id = t.journal_entry_id
         join public.ledger_accounts a on a.id = l.account_id
        where t.id = $1
        order by a.code`,
      [txnId],
    );

    expect(lines).toHaveLength(2);

    const liability = lines.find((l) => l.code === '2100');
    expect(liability, 'the deposit must reach 2100 Member Savings').toBeDefined();
    expect(liability?.account_type).toBe('liability');
    expect(Number(liability?.credit)).toBe(60_000);
    expect(Number(liability?.debit)).toBe(0);

    const cash = lines.find((l) => l.code !== '2100');
    expect(cash?.account_type).toBe('asset');
    expect(Number(cash?.debit)).toBe(60_000);

    // The thing that would be catastrophic and silent.
    expect(
      lines.some((l) => l.account_type === 'income'),
      'a savings deposit is not income',
    ).toBe(false);
  });

  it('keeps the subledger and the 2100 ledger balance equal', async () => {
    const before = await liabilityBalance();
    const beforeSub = await subledgerTotal();
    expect(beforeSub).toBe(before);

    const { savingsAccountId } = await saver();
    await depositOn(savingsAccountId, 50_000);
    await depositOn(savingsAccountId, 25_000, {
      paymentMethod: 'mtn_mobile_money',
      externalReference: 'MM-4411-A',
    });

    expect(await subledgerTotal()).toBe(beforeSub + 75_000);
    expect(await liabilityBalance()).toBe(await subledgerTotal());
  });

  it('is recorded once when the same idempotency key arrives twice', async () => {
    const { savingsAccountId } = await saver();
    const key = await queryOne<{ k: string }>(`select gen_random_uuid() as k`);

    const first = await queryOne<{ id: string }>(
      `select public.post_savings_deposit($1, 40000, 'cash', null, $2) as id`,
      [savingsAccountId, key.k],
    );
    const second = await queryOne<{ id: string }>(
      `select public.post_savings_deposit($1, 40000, 'cash', null, $2) as id`,
      [savingsAccountId, key.k],
    );

    expect(second.id, 'a replayed key returns the first transaction').toBe(first.id);
    expect(await balanceOf(savingsAccountId)).toBe(40_000);

    const entries = await queryOne<{ n: string }>(
      `select count(*) as n from public.journal_entries
        where source_type = 'savings_deposit' and source_id = $1`,
      [first.id],
    );
    expect(Number(entries.n), 'one journal entry, not two').toBe(1);
  });

  it('refuses a deposit of zero or less, and an unknown payment method', async () => {
    const { savingsAccountId } = await saver();

    const zero = await expectError(
      `select public.post_savings_deposit($1, 0, 'cash', null, gen_random_uuid())`,
      [savingsAccountId],
    );
    expect(zero?.message).toContain('more than zero shillings');

    const unknown = await expectError(
      `select public.post_savings_deposit($1, 10000, 'sacco_voucher', 'X1234', gen_random_uuid())`,
      [savingsAccountId],
    );
    expect(unknown?.message).toContain('Unknown payment method');
  });

  it('requires a network reference for mobile money and refuses one for cash', async () => {
    const { savingsAccountId } = await saver();

    const missing = await expectError(
      `select public.post_savings_deposit($1, 10000, 'airtel_money', null, gen_random_uuid())`,
      [savingsAccountId],
    );
    expect(missing?.message).toContain('reference from the network');

    const spurious = await expectError(
      `select public.post_savings_deposit($1, 10000, 'cash', 'MM-9999', gen_random_uuid())`,
      [savingsAccountId],
    );
    expect(spurious?.message).toContain('cash deposit has no network reference');
  });
});

// ===========================================================================
describeDb('the subledger is append-only', () => {
  it('refuses an UPDATE and a DELETE, even as the table owner', async () => {
    const { savingsAccountId } = await saver();
    const txnId = await depositOn(savingsAccountId, 50_000);

    const updated = await expectError(
      `update public.savings_transactions set notes = 'adjusted' where id = $1`,
      [txnId],
    );
    expect(updated?.message).toContain('append-only');

    const deleted = await expectError(
      `delete from public.savings_transactions where id = $1`,
      [txnId],
    );
    expect(deleted?.message).toContain('append-only');
  });

  it('grants an application role no privilege to write it at all', async () => {
    const { savingsAccountId } = await saver();
    const txnId = await depositOn(savingsAccountId, 50_000);

    const attempted = await asUser(
      fx.owner,
      `update public.savings_transactions set amount = 1 where id = $1`,
      [txnId],
    );

    expect(attempted.ok).toBe(false);
    expect(attempted.message ?? '').toMatch(/permission denied|append-only/i);
  });
});

// ===========================================================================
describeDb('contribution months', () => {
  it('accumulates several deposits in one month into one qualifying month', async () => {
    const { savingsAccountId } = await saver();
    const month = monthStart(fx.thisMonth, 2);

    await depositOn(savingsAccountId, 20_000, { on: dayInMonth(fx.thisMonth, 2, 3) });
    await depositOn(savingsAccountId, 15_000, { on: dayInMonth(fx.thisMonth, 2, 14) });
    await depositOn(savingsAccountId, 15_000, { on: dayInMonth(fx.thisMonth, 2, 27) });

    const row = await queryOne<{
      contributed: string;
      deposit_count: string;
      meets_minimum: boolean;
      shortfall: string;
    }>(
      `select contributed, deposit_count, meets_minimum, shortfall
         from public.member_savings_contributions
        where savings_account_id = $1 and contribution_month = $2`,
      [savingsAccountId, month],
    );

    expect(Number(row.contributed)).toBe(50_000);
    expect(Number(row.deposit_count)).toBe(3);
    expect(
      row.meets_minimum,
      'three deposits reaching 50,000 is a qualifying month',
    ).toBe(true);
    expect(Number(row.shortfall)).toBe(0);
  });

  it('does not count a month that fell short, and says by how much', async () => {
    const { savingsAccountId } = await saver();
    const month = monthStart(fx.thisMonth, 3);

    await depositOn(savingsAccountId, 30_000, { on: dayInMonth(fx.thisMonth, 3, 9) });

    const row = await queryOne<{ meets_minimum: boolean; shortfall: string }>(
      `select meets_minimum, shortfall
         from public.member_savings_contributions
        where savings_account_id = $1 and contribution_month = $2`,
      [savingsAccountId, month],
    );

    expect(row.meets_minimum).toBe(false);
    expect(Number(row.shortfall)).toBe(20_000);
  });

  it('attributes a reversal to the month of the deposit it corrects', async () => {
    const { savingsAccountId } = await saver();
    const older = monthStart(fx.thisMonth, 4);

    // A qualifying month, four months ago.
    const mistaken = await depositOn(savingsAccountId, 50_000, {
      on: dayInMonth(fx.thisMonth, 4, 6),
    });
    // Enough left behind that the reversal is affordable.
    await depositOn(savingsAccountId, 50_000, { on: dayInMonth(fx.thisMonth, 1, 6) });

    // Reversed today, which is a different month.
    await query(
      `select public.reverse_savings_transaction($1, 'Posted to the wrong member')`,
      [mistaken],
    );

    const row = await queryOne<{
      contributed: string;
      reversed: string;
      meets_minimum: boolean;
    }>(
      `select contributed, reversed, meets_minimum
         from public.member_savings_contributions
        where savings_account_id = $1 and contribution_month = $2`,
      [savingsAccountId, older],
    );

    expect(
      Number(row.contributed),
      'the month the deposit was in is the month it stops counting in',
    ).toBe(0);
    expect(Number(row.reversed)).toBe(50_000);
    expect(row.meets_minimum).toBe(false);

    // And the current month, where the reversal was *recorded*, is untouched
    // by it: it holds nothing at all.
    const currentMonth = await query(
      `select 1 from public.member_savings_contributions
        where savings_account_id = $1 and contribution_month = $2`,
      [savingsAccountId, monthStart(fx.thisMonth, 0)],
    );
    expect(currentMonth).toHaveLength(0);
  });

  it('leaves withdrawals out: they reduce the balance, not what was contributed', async () => {
    const { savingsAccountId } = await saver();
    const month = monthStart(fx.thisMonth, 1);

    await depositOn(savingsAccountId, 80_000, { on: dayInMonth(fx.thisMonth, 1, 4) });

    const request = await queryOne<{ id: string }>(
      `select public.request_savings_withdrawal($1, 30000, 'School fees') as id`,
      [savingsAccountId],
    );
    await query(`select public.decide_savings_withdrawal($1, true, 'Approved')`, [
      request.id,
    ]);
    await query(
      `select public.post_savings_withdrawal($1, 'cash', null, gen_random_uuid())`,
      [request.id],
    );

    expect(await balanceOf(savingsAccountId)).toBe(50_000);

    const row = await queryOne<{ contributed: string }>(
      `select contributed from public.member_savings_contributions
        where savings_account_id = $1 and contribution_month = $2`,
      [savingsAccountId, month],
    );
    expect(Number(row.contributed), 'a withdrawal is not a negative contribution').toBe(
      80_000,
    );
  });
});

// ===========================================================================
describeDb('qualification', () => {
  it('qualifies after six qualifying months and not before', async () => {
    const { savingsAccountId } = await saver();

    for (let back = 6; back >= 2; back -= 1) {
      await depositOn(savingsAccountId, 50_000, {
        on: dayInMonth(fx.thisMonth, back, 10),
      });
    }

    const five = await queryOne<{
      qualifying_months: number;
      qualifies: boolean;
      months_short: number;
    }>(
      `select qualifying_months, qualifies, months_short
          from public.member_savings_qualification($1)`,
      [savingsAccountId],
    );

    expect(five.qualifying_months).toBe(5);
    expect(five.months_short).toBe(1);
    expect(five.qualifies, 'five months is not six').toBe(false);

    await depositOn(savingsAccountId, 50_000, { on: dayInMonth(fx.thisMonth, 1, 10) });

    const six = await queryOne<{
      qualifying_months: number;
      qualifies: boolean;
      months_short: number;
      balance: string;
      blocked_reason: string | null;
    }>(
      `select qualifying_months, qualifies, months_short, balance, blocked_reason
          from public.member_savings_qualification($1)`,
      [savingsAccountId],
    );

    expect(six.qualifying_months).toBe(6);
    expect(six.months_short).toBe(0);
    expect(six.qualifies).toBe(true);
    expect(six.blocked_reason).toBeNull();
    expect(Number(six.balance)).toBe(300_000);
  });

  it('answers as of a past date without letting a later deposit change it', async () => {
    const { savingsAccountId } = await saver();

    for (let back = 7; back >= 2; back -= 1) {
      await depositOn(savingsAccountId, 50_000, {
        on: dayInMonth(fx.thisMonth, back, 12),
      });
    }

    // On the last day of the month six months back, only two months had been
    // served, whatever has happened since.
    const asOf = dayInMonth(fx.thisMonth, 6, 28);

    const snapshot = await queryOne<{ qualifying_months: number; qualifies: boolean }>(
      `select qualifying_months, qualifies
         from public.member_savings_qualification($1, $2::date)`,
      [savingsAccountId, asOf],
    );
    expect(snapshot.qualifying_months).toBe(2);
    expect(snapshot.qualifies).toBe(false);

    // A deposit now, dated now, must not rewrite that answer.
    await depositOn(savingsAccountId, 50_000);

    const again = await queryOne<{ qualifying_months: number; qualifies: boolean }>(
      `select qualifying_months, qualifies
         from public.member_savings_qualification($1, $2::date)`,
      [savingsAccountId, asOf],
    );
    expect(again.qualifying_months, 'a snapshot is a snapshot').toBe(2);
    expect(again.qualifies).toBe(false);
  });

  it('counts the longest unbroken run, and applies the consecutive rule when the policy sets it', async () => {
    const { savingsAccountId } = await saver();

    // Six qualifying months with a gap in the middle: 7, 6, 5, then 3, 2, 1.
    for (const back of [7, 6, 5, 3, 2, 1]) {
      await depositOn(savingsAccountId, 50_000, {
        on: dayInMonth(fx.thisMonth, back, 8),
      });
    }

    const lenient = await queryOne<{
      qualifying_months: number;
      longest_consecutive_months: number;
      qualifies: boolean;
      must_be_consecutive: boolean;
    }>(
      `select qualifying_months, longest_consecutive_months, qualifies, must_be_consecutive
         from public.member_savings_qualification($1)`,
      [savingsAccountId],
    );

    expect(lenient.must_be_consecutive).toBe(false);
    expect(lenient.qualifying_months).toBe(6);
    expect(lenient.longest_consecutive_months, 'the run broke after three').toBe(3);
    expect(lenient.qualifies, 'six months, consecutive not required').toBe(true);

    // The same history under the other arm of the client's rule. Switching the
    // policy version's answer is an owner-level act for the same reason
    // `forcePolicyStatus` is: the rule is one-way for every caller, and a
    // fixture needing both arms is not a counter-example to it.
    await query(
      `alter table public.membership_policy_versions
         disable trigger membership_policy_versions_guard`,
    );
    try {
      await query(
        `update public.membership_policy_versions
            set qualifying_months_consecutive = true
          where id = $1`,
        [fx.policyId],
      );

      const strict = await queryOne<{
        qualifies: boolean;
        must_be_consecutive: boolean;
        blocked_reason: string | null;
      }>(
        `select qualifies, must_be_consecutive, blocked_reason
           from public.member_savings_qualification($1)`,
        [savingsAccountId],
      );

      expect(strict.must_be_consecutive).toBe(true);
      expect(strict.qualifies, 'the same six months, now with a gap that counts').toBe(
        false,
      );
      expect(strict.blocked_reason ?? '').toMatch(
        /longest unbroken run of qualifying months is 3 of the 6 required/i,
      );
    } finally {
      await query(
        `update public.membership_policy_versions
            set qualifying_months_consecutive = false
          where id = $1`,
        [fx.policyId],
      );
      await query(
        `alter table public.membership_policy_versions
           enable trigger membership_policy_versions_guard`,
      );
    }
  });
});

// ===========================================================================
describeDb('the withdrawal lifecycle', () => {
  it('debits the liability and credits cash when a withdrawal is paid', async () => {
    const { savingsAccountId } = await saver();
    await depositOn(savingsAccountId, 120_000);

    const beforeLiability = await liabilityBalance();

    const request = await queryOne<{ id: string }>(
      `select public.request_savings_withdrawal($1, 45000, 'Roof repair') as id`,
      [savingsAccountId],
    );
    await query(`select public.decide_savings_withdrawal($1, true, 'Approved')`, [
      request.id,
    ]);
    const paid = await queryOne<{ id: string }>(
      `select public.post_savings_withdrawal($1, 'cash', null, gen_random_uuid()) as id`,
      [request.id],
    );

    const lines = await query<{ code: string; debit: string; credit: string }>(
      `select a.code, l.debit, l.credit
         from public.savings_transactions t
         join public.journal_lines l on l.entry_id = t.journal_entry_id
         join public.ledger_accounts a on a.id = l.account_id
        where t.id = $1`,
      [paid.id],
    );

    const liability = lines.find((l) => l.code === '2100');
    expect(Number(liability?.debit), 'the liability falls').toBe(45_000);
    expect(Number(liability?.credit)).toBe(0);

    expect(await balanceOf(savingsAccountId)).toBe(75_000);
    expect(await liabilityBalance()).toBe(beforeLiability - 45_000);
    expect(await liabilityBalance()).toBe(await subledgerTotal());

    const status = await queryOne<{ status: string }>(
      `select status from public.savings_withdrawal_requests where id = $1`,
      [request.id],
    );
    expect(status.status).toBe('paid');
  });

  it('refuses a request for more than the balance', async () => {
    const { savingsAccountId } = await saver();
    await depositOn(savingsAccountId, 50_000);

    const refused = await expectError(
      `select public.request_savings_withdrawal($1, 50001, 'Too much')`,
      [savingsAccountId],
    );
    expect(refused?.message).toContain('cannot be prepared');
  });

  it('refuses a decision from the person who prepared it', async () => {
    const { savingsAccountId } = await saver();
    await depositOn(savingsAccountId, 60_000);

    const prepared = await asUser(
      fx.manager,
      `select public.request_savings_withdrawal($1, 20000, 'Medical') as id`,
      [savingsAccountId],
    );
    // `asUser` rolls back, so the request has to be prepared on a committed
    // connection with the manager's identity for the refusal below to have
    // something to refuse.
    expect(prepared.ok).toBe(true);

    const client = await getClient();
    let requestId: string;
    try {
      await client.query('begin');
      await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
        fx.manager.authUserId,
      ]);
      await client.query('set local role authenticated');
      const row = await client.query(
        `select public.request_savings_withdrawal($1, 20000, 'Medical') as id`,
        [savingsAccountId],
      );
      requestId = (row.rows[0] as { id: string }).id;
      await client.query('reset role');
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const self = await asUser(
      fx.manager,
      `select public.decide_savings_withdrawal($1, true, 'Fine by me')`,
      [requestId],
    );
    expect(self.ok).toBe(false);
    expect(self.message ?? '').toMatch(
      /cannot be decided by the person who prepared it/i,
    );

    // Somebody else may.
    const other = await asUser(
      fx.approver,
      `select public.decide_savings_withdrawal($1, true, 'Checked the balance')`,
      [requestId],
    );
    expect(other.ok).toBe(true);
  });

  it('refuses a second live request on the same account', async () => {
    const { savingsAccountId } = await saver();
    await depositOn(savingsAccountId, 90_000);

    await query(`select public.request_savings_withdrawal($1, 10000, 'First')`, [
      savingsAccountId,
    ]);

    const second = await expectError(
      `select public.request_savings_withdrawal($1, 10000, 'Second')`,
      [savingsAccountId],
    );
    expect(second?.message ?? '').toMatch(/already|one|live|pending/i);
  });

  it('pays only an approved request, and refuses a rejected one with no reason', async () => {
    const { savingsAccountId } = await saver();
    await depositOn(savingsAccountId, 70_000);

    const request = await queryOne<{ id: string }>(
      `select public.request_savings_withdrawal($1, 20000, 'Fees') as id`,
      [savingsAccountId],
    );

    const early = await expectError(
      `select public.post_savings_withdrawal($1, 'cash', null, gen_random_uuid())`,
      [request.id],
    );
    expect(early?.message).toContain('Only an approved request is paid');

    const silent = await expectError(
      `select public.decide_savings_withdrawal($1, false, null)`,
      [request.id],
    );
    expect(silent?.message).toContain('rejected withdrawal must say why');

    await query(
      `select public.decide_savings_withdrawal($1, false, 'Balance is pledged')`,
      [request.id],
    );

    const decided = await expectError(
      `select public.decide_savings_withdrawal($1, true, 'Changed my mind')`,
      [request.id],
    );
    expect(decided?.message).toContain('nothing to decide');
  });

  it('refuses to pay an approved withdrawal once the balance has moved below it', async () => {
    const { savingsAccountId } = await saver();
    await depositOn(savingsAccountId, 100_000);

    const request = await queryOne<{ id: string }>(
      `select public.request_savings_withdrawal($1, 100000, 'All of it') as id`,
      [savingsAccountId],
    );
    await query(`select public.decide_savings_withdrawal($1, true, 'Approved')`, [
      request.id,
    ]);

    // Something else spends it between the decision and the counter: a second
    // account cannot do this, so the deposit it spends is reversed instead.
    const deposit = await queryOne<{ id: string }>(
      `select id from public.savings_transactions
        where savings_account_id = $1 and kind = 'deposit'`,
      [savingsAccountId],
    );
    await query(`select public.reverse_savings_transaction($1, 'Cheque bounced')`, [
      deposit.id,
    ]);

    const refused = await expectError(
      `select public.post_savings_withdrawal($1, 'cash', null, gen_random_uuid())`,
      [request.id],
    );
    expect(refused?.message).toContain('The balance moved after the decision');
  });

  it('is paid once when the same idempotency key arrives twice', async () => {
    const { savingsAccountId } = await saver();
    await depositOn(savingsAccountId, 80_000);

    const request = await queryOne<{ id: string }>(
      `select public.request_savings_withdrawal($1, 30000, 'Stock') as id`,
      [savingsAccountId],
    );
    await query(`select public.decide_savings_withdrawal($1, true, 'Approved')`, [
      request.id,
    ]);

    const key = await queryOne<{ k: string }>(`select gen_random_uuid() as k`);
    const first = await queryOne<{ id: string }>(
      `select public.post_savings_withdrawal($1, 'cash', null, $2) as id`,
      [request.id, key.k],
    );
    const second = await queryOne<{ id: string }>(
      `select public.post_savings_withdrawal($1, 'cash', null, $2) as id`,
      [request.id, key.k],
    );

    expect(second.id).toBe(first.id);
    expect(await balanceOf(savingsAccountId)).toBe(50_000);
  });

  it('cancels a pending request without moving any money', async () => {
    const { savingsAccountId } = await saver();
    await depositOn(savingsAccountId, 60_000);

    const request = await queryOne<{ id: string }>(
      `select public.request_savings_withdrawal($1, 25000, 'Changed plans') as id`,
      [savingsAccountId],
    );
    await query(
      `select public.cancel_savings_withdrawal($1, 'Member withdrew the request')`,
      [request.id],
    );

    const status = await queryOne<{ status: string }>(
      `select status from public.savings_withdrawal_requests where id = $1`,
      [request.id],
    );
    expect(status.status).toBe('cancelled');
    expect(await balanceOf(savingsAccountId)).toBe(60_000);

    // And the account is free to take another request.
    const next = await queryOne<{ id: string }>(
      `select public.request_savings_withdrawal($1, 10000, 'Smaller') as id`,
      [savingsAccountId],
    );
    expect(next.id).not.toBe(request.id);
  });
});

// ===========================================================================
describeDb('reversal', () => {
  it('writes a contra transaction and a contra journal, and never edits the original', async () => {
    const { savingsAccountId } = await saver();
    const original = await depositOn(savingsAccountId, 50_000);

    const before = await queryOne<{ amount: string; kind: string }>(
      `select amount, kind from public.savings_transactions where id = $1`,
      [original],
    );

    const contra = await queryOne<{ id: string }>(
      `select public.reverse_savings_transaction($1, 'Counted twice at the counter') as id`,
      [original],
    );

    const after = await queryOne<{ amount: string; kind: string }>(
      `select amount, kind from public.savings_transactions where id = $1`,
      [original],
    );
    expect(after).toEqual(before);

    const row = await queryOne<{
      kind: string;
      amount: string;
      signed_amount: string;
      reverses_transaction_id: string;
      reversal_reason: string;
    }>(
      `select kind, amount, signed_amount, reverses_transaction_id, reversal_reason
         from public.savings_transactions where id = $1`,
      [contra.id],
    );
    expect(row.kind).toBe('deposit_reversal');
    expect(Number(row.amount)).toBe(50_000);
    expect(Number(row.signed_amount), 'the contra signs itself').toBe(-50_000);
    expect(row.reverses_transaction_id).toBe(original);

    const lines = await query<{ code: string; debit: string; credit: string }>(
      `select a.code, l.debit, l.credit
         from public.journal_lines l
         join public.ledger_accounts a on a.id = l.account_id
        where l.entry_id = (select journal_entry_id from public.savings_transactions
                             where id = $1)`,
      [contra.id],
    );
    const liability = lines.find((l) => l.code === '2100');
    expect(Number(liability?.debit), 'every leg the other way round').toBe(50_000);

    expect(await balanceOf(savingsAccountId)).toBe(0);
    expect(await liabilityBalance()).toBe(await subledgerTotal());
  });

  it('refuses a second reversal, and refuses reversing a reversal', async () => {
    const { savingsAccountId } = await saver();
    const original = await depositOn(savingsAccountId, 50_000);

    const contra = await queryOne<{ id: string }>(
      `select public.reverse_savings_transaction($1, 'Posted in error') as id`,
      [original],
    );

    const twice = await expectError(
      `select public.reverse_savings_transaction($1, 'Again, somehow')`,
      [original],
    );
    expect(twice?.message).toContain('has already been reversed');

    const ofAReversal = await expectError(
      `select public.reverse_savings_transaction($1, 'Undo the undo')`,
      [contra.id],
    );
    expect(ofAReversal?.message).toContain('itself a reversal');
  });

  it('refuses to reverse a deposit that has already been withdrawn', async () => {
    const { savingsAccountId } = await saver();
    const deposit = await depositOn(savingsAccountId, 50_000);

    const request = await queryOne<{ id: string }>(
      `select public.request_savings_withdrawal($1, 50000, 'All of it') as id`,
      [savingsAccountId],
    );
    await query(`select public.decide_savings_withdrawal($1, true, 'Approved')`, [
      request.id,
    ]);
    await query(
      `select public.post_savings_withdrawal($1, 'cash', null, gen_random_uuid())`,
      [request.id],
    );

    const refused = await expectError(
      `select public.reverse_savings_transaction($1, 'Should not have been taken')`,
      [deposit],
    );
    expect(refused?.message, 'a liability must not be pushed below nothing').toContain(
      'Reverse the withdrawals that spent it first',
    );
  });

  it('requires a reason of at least four characters', async () => {
    const { savingsAccountId } = await saver();
    const deposit = await depositOn(savingsAccountId, 50_000);

    const refused = await expectError(
      `select public.reverse_savings_transaction($1, ' x ')`,
      [deposit],
    );
    expect(refused?.message).toContain('must say why');
  });
});

// ===========================================================================
describeDb('the statement', () => {
  it('runs a balance that matches the account, line by line', async () => {
    const { savingsAccountId } = await saver();

    await depositOn(savingsAccountId, 50_000, { on: dayInMonth(fx.thisMonth, 3, 5) });
    await depositOn(savingsAccountId, 60_000, { on: dayInMonth(fx.thisMonth, 2, 5) });

    const request = await queryOne<{ id: string }>(
      `select public.request_savings_withdrawal($1, 40000, 'Fees') as id`,
      [savingsAccountId],
    );
    await query(`select public.decide_savings_withdrawal($1, true, 'Approved')`, [
      request.id,
    ]);
    await query(
      `select public.post_savings_withdrawal($1, 'cash', null, gen_random_uuid())`,
      [request.id],
    );

    const lines = await query<{
      kind: string;
      deposit: string;
      withdrawal: string;
      running_balance: string;
    }>(
      `select kind, deposit, withdrawal, running_balance
         from public.savings_statement($1)`,
      [savingsAccountId],
    );

    expect(lines).toHaveLength(3);
    expect(lines.map((l) => Number(l.running_balance))).toEqual([
      50_000, 110_000, 70_000,
    ]);
    expect(Number(lines[2]?.withdrawal)).toBe(40_000);
    expect(Number(lines[2]?.deposit)).toBe(0);
    expect(Number(lines.at(-1)?.running_balance)).toBe(await balanceOf(savingsAccountId));
  });

  it('opens a period at the balance that period actually opened at', async () => {
    const { savingsAccountId } = await saver();

    await depositOn(savingsAccountId, 50_000, { on: dayInMonth(fx.thisMonth, 3, 7) });
    await depositOn(savingsAccountId, 70_000, { on: dayInMonth(fx.thisMonth, 1, 7) });

    const period = await query<{ running_balance: string }>(
      `select running_balance from public.savings_statement($1, $2::date, $3::date)`,
      [savingsAccountId, monthStart(fx.thisMonth, 1), dayInMonth(fx.thisMonth, 1, 28)],
    );

    expect(period).toHaveLength(1);
    expect(
      Number(period[0]?.running_balance),
      'the window runs over the whole account, then the period is filtered',
    ).toBe(120_000);
  });
});

// ===========================================================================
describeDb('the savings position', () => {
  it('reports a liability that equals the 2100 ledger balance', async () => {
    const { savingsAccountId } = await saver();
    await depositOn(savingsAccountId, 55_000);

    const summary = await queryOne<{
      total_liability: string;
      deposits_count: number;
      accounts_open: number;
    }>(
      `select total_liability, deposits_count, accounts_open from public.savings_summary()`,
    );

    expect(Number(summary.total_liability)).toBe(await liabilityBalance());
    expect(summary.accounts_open).toBeGreaterThan(0);
  });
});

// ===========================================================================
describeDb(
  'an account is not opened twice, and not opened at all without a decided policy',
  () => {
    it('returns the same account when open_savings_account is called again', async () => {
      const { membershipId, savingsAccountId } = await saver();

      const again = await queryOne<{ id: string }>(
        `select public.open_savings_account($1) as id`,
        [membershipId],
      );
      expect(again.id).toBe(savingsAccountId);

      const count = await queryOne<{ n: string }>(
        `select count(*) as n from public.savings_accounts where membership_id = $1`,
        [membershipId],
      );
      expect(Number(count.n)).toBe(1);
    });

    it('refuses to open an account while the savings rules are undecided', async () => {
      // The activity-specific readiness gate. `is_savings_enabled` waits on the
      // qualification rule and the withdrawal rule and on nothing else, so a
      // version with either of them open takes no savings — while enrolment
      // under it carries on, which is the whole point of splitting the gates.
      const clientId = await makeClient('Undecided Saver', '+256700399111');
      const membership = await queryOne<{ id: string }>(
        `insert into public.memberships (client_id, applied_on)
       values ($1, public.business_date()) returning id`,
        [clientId],
      );

      // Reopening a decided rule is an owner-level act, for the same reason
      // `forcePolicyStatus` is: the contractual columns freeze once anybody is
      // enrolled, and a fixture that needs the undecided state back is not a
      // counter-example to that.
      await query(
        `alter table public.membership_policy_versions
         disable trigger membership_policy_versions_guard`,
      );
      try {
        await query(
          `update public.membership_policy_versions
            set savings_withdrawal_with_active_loan = null
          where id = $1`,
          [fx.policyId],
        );

        const refused = await expectError(`select public.open_savings_account($1)`, [
          membership.id,
        ]);
        expect(refused?.message ?? '').toMatch(
          /savings rules|not been decided|not open/i,
        );
      } finally {
        await query(
          `update public.membership_policy_versions
            set savings_withdrawal_with_active_loan = 'allowed'
          where id = $1`,
          [fx.policyId],
        );
        await query(
          `alter table public.membership_policy_versions
           enable trigger membership_policy_versions_guard`,
        );
      }
    });
  },
);
