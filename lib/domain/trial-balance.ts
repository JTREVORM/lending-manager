/**
 * The trial balance, as a reading of `public.trial_balance`.
 *
 * ## There is one source of truth, and it is the view
 *
 * `public.trial_balance` groups `journal_lines` by account and returns the
 * debit total and the credit total of each. Nothing here re-derives those two
 * figures, sums journal lines, or asks the database a second question: the
 * view is the answer, and this module arranges it.
 *
 * What it *does* compute is the presentation a trial balance has always had:
 * each account's **net** balance placed in whichever column it falls on, and
 * the four totals at the foot. That is arithmetic over figures the ledger has
 * already decided — the same relationship to the ledger that
 * `collection-report-view` has to the payment register — and it is kept here,
 * pure and tested, rather than inside a component.
 *
 * ## Why both pairs of columns are shown
 *
 * `total_debit` and `total_credit` are **movement**: everything ever debited
 * and everything ever credited to that account. `debitBalance` and
 * `creditBalance` are the **net**, on one side only. A reader needs both, and
 * confusing them is the classic way to misread a trial balance: an account
 * with a million debited and a million credited has moved two million and
 * holds nothing, and a page showing only the net would say the account was
 * never used.
 *
 * Both pairs foot to equal totals when the ledger is sound, and for the same
 * reason. Every journal entry balances — the database enforces it with a
 * deferred constraint trigger over the whole entry — so the gross columns
 * agree by construction; and because the signed sum of every line is
 * therefore zero, the positives and the negatives of the nets are equal too.
 *
 * ## Zero is not nothing
 *
 * An account with no movement at all is still part of the chart and still a
 * row. A trial balance that hid its empty accounts would be a trial balance
 * whose row count changed with the day, and the first person to total it
 * against a printed copy from last month would find rows missing. `movement`
 * is reported per line so a reader can tell the two apart.
 */

import { ACCOUNT_TYPE_LABELS, type AccountType } from '@/lib/domain/finance';
import { subtractUgx, sumUgx, toUgx, type UgxAmount } from '@/lib/domain/money';

/** Which side an account normally carries. Mirrors `ledger_accounts`. */
export const NORMAL_SIDES = ['debit', 'credit'] as const;
export type NormalSide = (typeof NORMAL_SIDES)[number];

export function isNormalSide(value: unknown): value is NormalSide {
  return typeof value === 'string' && (NORMAL_SIDES as readonly string[]).includes(value);
}

/** One row of `public.trial_balance`, as read. */
export interface TrialBalanceAccount {
  readonly code: string;
  readonly name: string;
  readonly accountType: AccountType;
  readonly normalSide: NormalSide;
  /** Everything ever debited to this account. */
  readonly totalDebit: UgxAmount;
  /** Everything ever credited to it. */
  readonly totalCredit: UgxAmount;
}

/** The same row, with the net balance placed on its side. */
export interface TrialBalanceLine extends TrialBalanceAccount {
  /** The net, when it falls on the debit side. Zero otherwise. */
  readonly debitBalance: UgxAmount;
  /** The net, when it falls on the credit side. Zero otherwise. */
  readonly creditBalance: UgxAmount;
  /** Anything was ever posted to this account. */
  readonly movement: boolean;
  /**
   * The net sits on the side this account does not normally carry — an asset
   * in credit, an income account in debit.
   *
   * Not an error: a bank account can legitimately be overdrawn and a refunded
   * fee can push an income account into debit. It is flagged because it is
   * the thing a reader checking a trial balance is looking for.
   */
  readonly contra: boolean;
}

export interface TrialBalanceSummary {
  readonly lines: readonly TrialBalanceLine[];
  /** Σ of every account's debit movement. */
  readonly totalDebit: UgxAmount;
  /** Σ of every account's credit movement. */
  readonly totalCredit: UgxAmount;
  /** Σ of the net debit column. */
  readonly debitBalanceTotal: UgxAmount;
  /** Σ of the net credit column. */
  readonly creditBalanceTotal: UgxAmount;
  /** `totalDebit − totalCredit`. Zero when the ledger is sound. */
  readonly movementDifference: UgxAmount;
  /** `debitBalanceTotal − creditBalanceTotal`. Zero when the ledger is sound. */
  readonly balanceDifference: UgxAmount;
  /**
   * Both differences are exactly zero.
   *
   * Exactly: these are whole shillings in integer arithmetic throughout, so
   * there is no tolerance to apply and a near miss is a real defect rather
   * than a rounding artefact.
   */
  readonly balanced: boolean;
  readonly accountCount: number;
  readonly accountsWithMovement: number;
}

const ZERO = toUgx(0);

/** One account's net balance, placed on the side it falls on. */
export function toTrialBalanceLine(account: TrialBalanceAccount): TrialBalanceLine {
  const net = subtractUgx(account.totalDebit, account.totalCredit);

  const debitBalance = net > 0 ? net : ZERO;
  // `subtractUgx(ZERO, net)` rather than negating: the sign flip goes through
  // the money layer like every other operation on an amount, which is what
  // keeps the branded type meaningful.
  const creditBalance = net < 0 ? subtractUgx(ZERO, net) : ZERO;

  const movement = account.totalDebit !== 0 || account.totalCredit !== 0;

  return {
    ...account,
    debitBalance,
    creditBalance,
    movement,
    contra: net === 0 ? false : account.normalSide === 'debit' ? net < 0 : net > 0,
  };
}

/**
 * The whole statement: every line, the four totals, and whether it balances.
 *
 * The caller hands in the view's rows in the order the view returned them —
 * by account code — and that order is kept. A trial balance is read against a
 * chart of accounts, and re-sorting it would mean a reader comparing two
 * printings line by line could not.
 */
export function summariseTrialBalance(
  accounts: readonly TrialBalanceAccount[],
): TrialBalanceSummary {
  const lines = accounts.map(toTrialBalanceLine);

  const totalDebit = sumUgx(lines.map((line) => line.totalDebit));
  const totalCredit = sumUgx(lines.map((line) => line.totalCredit));
  const debitBalanceTotal = sumUgx(lines.map((line) => line.debitBalance));
  const creditBalanceTotal = sumUgx(lines.map((line) => line.creditBalance));

  const movementDifference = subtractUgx(totalDebit, totalCredit);
  const balanceDifference = subtractUgx(debitBalanceTotal, creditBalanceTotal);

  return {
    lines,
    totalDebit,
    totalCredit,
    debitBalanceTotal,
    creditBalanceTotal,
    movementDifference,
    balanceDifference,
    balanced: movementDifference === 0 && balanceDifference === 0,
    accountCount: lines.length,
    accountsWithMovement: lines.filter((line) => line.movement).length,
  };
}

/** The account type, for a column and for a CSV. */
export function accountTypeLabel(type: AccountType): string {
  return ACCOUNT_TYPE_LABELS[type];
}
