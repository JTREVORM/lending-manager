import { describe, expect, it } from 'vitest';

import { toUgx } from '@/lib/domain/money';
import {
  isNormalSide,
  summariseTrialBalance,
  toTrialBalanceLine,
  type TrialBalanceAccount,
} from '@/lib/domain/trial-balance';

/**
 * The trial balance's arithmetic.
 *
 * ## Why this is a unit test and not a database test
 *
 * The figures come from `public.trial_balance` and are not computed here —
 * `tests/db/trial-balance.test.ts` proves the view is sound against real
 * postings. What *is* computed here is the presentation: each account's net
 * balance placed on one side, and the four totals at the foot. Those are
 * decisions with edge cases — a contra balance, an account with equal debits
 * and credits, an empty chart — and each one below is a way a trial balance
 * can be wrong while looking right.
 *
 * Every figure is a whole shilling in integer arithmetic, so the assertions
 * are exact. There is no tolerance to apply and a near miss is a defect.
 */

const account = (
  overrides: Partial<TrialBalanceAccount> & Pick<TrialBalanceAccount, 'code'>,
): TrialBalanceAccount => ({
  name: `Account ${overrides.code}`,
  accountType: 'asset',
  normalSide: 'debit',
  totalDebit: toUgx(0),
  totalCredit: toUgx(0),
  ...overrides,
});

describe('one account on the trial balance', () => {
  it('puts a net debit in the debit column and nothing in the credit column', () => {
    const line = toTrialBalanceLine(
      account({ code: '1000', totalDebit: toUgx(900_000), totalCredit: toUgx(250_000) }),
    );

    expect(line.debitBalance).toBe(650_000);
    expect(line.creditBalance).toBe(0);
  });

  it('puts a net credit in the credit column, as a positive figure', () => {
    // Not `-450,000` in the debit column. A trial balance has two columns
    // precisely so that no figure on it is negative.
    const line = toTrialBalanceLine(
      account({
        code: '4000',
        accountType: 'income',
        normalSide: 'credit',
        totalDebit: toUgx(50_000),
        totalCredit: toUgx(500_000),
      }),
    );

    expect(line.creditBalance).toBe(450_000);
    expect(line.debitBalance).toBe(0);
  });

  it('keeps the gross movement separate from the net balance', () => {
    // A million through and nothing held. A statement showing only the net
    // would say this account was never used.
    const line = toTrialBalanceLine(
      account({
        code: '1100',
        totalDebit: toUgx(1_000_000),
        totalCredit: toUgx(1_000_000),
      }),
    );

    expect(line.totalDebit).toBe(1_000_000);
    expect(line.totalCredit).toBe(1_000_000);
    expect(line.debitBalance).toBe(0);
    expect(line.creditBalance).toBe(0);
    expect(line.movement).toBe(true);
  });

  it('reports an account with nothing posted to it as having no movement', () => {
    const line = toTrialBalanceLine(account({ code: '9000' }));

    expect(line.movement).toBe(false);
    expect(line.debitBalance).toBe(0);
    expect(line.creditBalance).toBe(0);
  });

  it('flags a balance sitting on the side the account does not normally carry', () => {
    // An overdrawn bank account is an asset in credit. Legitimate, and the
    // thing somebody checking a trial balance is looking for.
    const overdrawn = toTrialBalanceLine(
      account({
        code: '1020',
        normalSide: 'debit',
        totalDebit: toUgx(100_000),
        totalCredit: toUgx(400_000),
      }),
    );
    expect(overdrawn.contra).toBe(true);

    const normal = toTrialBalanceLine(
      account({ code: '1021', normalSide: 'debit', totalDebit: toUgx(400_000) }),
    );
    expect(normal.contra).toBe(false);
  });

  it('does not call a zero balance contra', () => {
    // Nothing is on the wrong side when nothing is on either side.
    const line = toTrialBalanceLine(
      account({
        code: '1030',
        normalSide: 'credit',
        totalDebit: toUgx(75_000),
        totalCredit: toUgx(75_000),
      }),
    );

    expect(line.contra).toBe(false);
  });
});

describe('the foot of the trial balance', () => {
  // A small, sound set of books: cash and loans on the debit side, equity and
  // income on the credit side, footing to 2,500,000 either way.
  const sound: readonly TrialBalanceAccount[] = [
    account({ code: '1000', name: 'Cash at Hand', totalDebit: toUgx(1_500_000) }),
    account({ code: '1200', name: 'Loans Receivable', totalDebit: toUgx(1_000_000) }),
    account({
      code: '3000',
      name: 'Owner Capital',
      accountType: 'equity',
      normalSide: 'credit',
      totalCredit: toUgx(2_000_000),
    }),
    account({
      code: '4000',
      name: 'Interest Income',
      accountType: 'income',
      normalSide: 'credit',
      totalCredit: toUgx(500_000),
    }),
  ];

  it('foots both pairs of columns to the same figure', () => {
    const summary = summariseTrialBalance(sound);

    expect(summary.totalDebit).toBe(2_500_000);
    expect(summary.totalCredit).toBe(2_500_000);
    expect(summary.debitBalanceTotal).toBe(2_500_000);
    expect(summary.creditBalanceTotal).toBe(2_500_000);
  });

  it('reports both differences as exactly zero, and says it balances', () => {
    const summary = summariseTrialBalance(sound);

    expect(summary.movementDifference).toBe(0);
    expect(summary.balanceDifference).toBe(0);
    expect(summary.balanced).toBe(true);
  });

  it('foots the nets even when accounts have movement on both sides', () => {
    // The gross columns and the net columns are different figures here, and
    // both must still foot: 3,700,000 of movement, 2,500,000 of balances.
    const summary = summariseTrialBalance([
      account({
        code: '1000',
        totalDebit: toUgx(2_100_000),
        totalCredit: toUgx(600_000),
      }),
      account({ code: '1200', totalDebit: toUgx(1_000_000) }),
      account({
        code: '3000',
        accountType: 'equity',
        normalSide: 'credit',
        totalCredit: toUgx(2_000_000),
      }),
      account({
        code: '4000',
        accountType: 'income',
        normalSide: 'credit',
        totalDebit: toUgx(600_000),
        totalCredit: toUgx(1_100_000),
      }),
    ]);

    expect(summary.totalDebit).toBe(3_700_000);
    expect(summary.totalCredit).toBe(3_700_000);
    expect(summary.debitBalanceTotal).toBe(2_500_000);
    expect(summary.creditBalanceTotal).toBe(2_500_000);
    expect(summary.balanced).toBe(true);
  });

  it('refuses to call a one-shilling difference balanced', () => {
    // Integer shillings throughout, so there is no rounding to forgive. A
    // page that tolerated this would be a page that hid a broken ledger.
    const summary = summariseTrialBalance([
      account({ code: '1000', totalDebit: toUgx(1_000_001) }),
      account({
        code: '3000',
        accountType: 'equity',
        normalSide: 'credit',
        totalCredit: toUgx(1_000_000),
      }),
    ]);

    expect(summary.movementDifference).toBe(1);
    expect(summary.balanceDifference).toBe(1);
    expect(summary.balanced).toBe(false);
  });

  it('reports a negative difference when credits exceed debits', () => {
    const summary = summariseTrialBalance([
      account({ code: '1000', totalDebit: toUgx(400_000) }),
      account({
        code: '3000',
        accountType: 'equity',
        normalSide: 'credit',
        totalCredit: toUgx(900_000),
      }),
    ]);

    expect(summary.movementDifference).toBe(-500_000);
    expect(summary.balanced).toBe(false);
  });

  it('keeps the chart order it was given', () => {
    // A reader compares two printings line by line. Re-sorting would make
    // that impossible, so the view's `order by code` is what reaches the page.
    const summary = summariseTrialBalance(sound);

    expect(summary.lines.map((line) => line.code)).toEqual([
      '1000',
      '1200',
      '3000',
      '4000',
    ]);
  });

  it('counts the accounts, and how many have movement', () => {
    const summary = summariseTrialBalance([...sound, account({ code: '9999' })]);

    expect(summary.accountCount).toBe(5);
    expect(summary.accountsWithMovement).toBe(4);
  });

  it('balances an empty chart without claiming anything about the books', () => {
    // Zero equals zero, so an empty chart is technically balanced. The page
    // is what must not present "could not be read" as this — see
    // `getTrialBalance`, which returns null rather than an empty statement.
    const summary = summariseTrialBalance([]);

    expect(summary.accountCount).toBe(0);
    expect(summary.totalDebit).toBe(0);
    expect(summary.balanced).toBe(true);
  });
});

describe('the normal side', () => {
  it('accepts the two the database allows and nothing else', () => {
    expect(isNormalSide('debit')).toBe(true);
    expect(isNormalSide('credit')).toBe(true);
    expect(isNormalSide('either')).toBe(false);
    expect(isNormalSide(null)).toBe(false);
    expect(isNormalSide(undefined)).toBe(false);
  });
});
