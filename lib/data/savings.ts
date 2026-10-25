import 'server-only';

import { mapDatabaseError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { UGX_ZERO, fromDatabaseAmount, type UgxAmount } from '@/lib/domain/money';
import {
  isSavingsAccountStatus,
  isSavingsTransactionKind,
  isWithdrawalStatus,
  type ConsentMethod,
  type ConsentVerificationStatus,
  type MembershipCardReason,
  type MembershipCardStatus,
  type MembershipFeeStatus,
  type SavingsAccountStatus,
  type SavingsTransactionKind,
  type WithdrawalStatus,
} from '@/lib/domain/savings';
import type { PaymentMethod } from '@/lib/domain/payment';
import type {
  SavingsSearchInput,
  SavingsStatementInput,
  WithdrawalSearchInput,
} from '@/lib/validation/savings';

/**
 * Reading savings.
 *
 * Every query here runs as the signed-in caller through
 * `createSupabaseServerClient`, never through the privileged client. That is
 * the reason none of these functions contains a capability check: the policies
 * decide what comes back, so a member calling `getSavingsAccount` with another
 * member's id gets nothing without this module containing a line about
 * members, and a Secretary gets their branch without this module containing a
 * line about branches.
 *
 * Using the service-role client here to "simplify" a query would move the
 * authorization decision out of the database and into whichever caller
 * remembered to make it. There is no such client in this file.
 *
 * ## Why the two reporting functions are read differently
 *
 * `savings_statement` and `member_savings_qualification` are SECURITY INVOKER,
 * so calling them as the signed-in caller applies the same policies a table
 * read would — which is exactly what makes them safe to expose. `savings_summary`
 * is SECURITY DEFINER because it reports the business as a whole, where there
 * is no row for a policy to filter; it checks `savings:view_reports` itself,
 * and `getSavingsSummary` below returns `null` rather than throwing when the
 * caller does not hold it, because a dashboard that 500s for a Secretary is
 * worse than one that leaves out a figure they were never meant to see.
 *
 * ## One round trip per screen
 *
 * The register reads `savings_account_register`, a `security_invoker` view that
 * joins the account to its balance, its member, its branch and its policy. The
 * balance itself comes from `member_savings_balances`, which computes
 * `sum(signed_amount)` — there is no stored balance anywhere in this schema for
 * a second figure to disagree with.
 *
 * ## Paging, not counting
 *
 * One row more than the page needs is fetched, and its presence is what
 * `hasMore` means. A `count: 'exact'` on every page view is a full scan of the
 * filtered set.
 */

export const SAVINGS_PAGE_SIZE = 20;
export const WITHDRAWALS_PAGE_SIZE = 20;
export const STATEMENT_PAGE_SIZE = 100;

/** Reads a money column that must be present. Zero is a value; null is a bug. */
function requiredAmount(value: number | string | null): UgxAmount {
  return fromDatabaseAmount(value) ?? UGX_ZERO;
}

/**
 * Escape a user-supplied search term for a PostgREST `ilike` pattern.
 *
 * `%` and `_` are wildcards and a comma terminates a value inside the `or()`
 * filter syntax, so an unescaped term lets a caller alter the shape of the
 * query. Not SQL injection — the values are still parameters — but filter
 * injection, and the fix is the same.
 */
function escapeSearchTerm(term: string): string {
  return term.replace(/[\\%_,()]/g, (match) => `\\${match}`);
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

/** A savings account as the register shows it. */
export interface SavingsAccountSummary {
  readonly id: string;
  readonly accountNumber: string;
  readonly membershipId: string;
  readonly membershipNumber: string;
  readonly membershipStatus: string;
  readonly clientId: string;
  readonly clientNumber: string;
  readonly fullName: string;
  readonly phone: string;
  readonly branchId: string | null;
  readonly branchName: string | null;
  readonly status: SavingsAccountStatus;
  readonly openedOn: string;
  readonly balance: UgxAmount;
  readonly totalDeposited: UgxAmount;
  readonly totalWithdrawn: UgxAmount;
  readonly transactionCount: number;
  readonly lastTransactionOn: string | null;
  readonly monthlySavingsMinimum: UgxAmount;
  readonly savingsQualifyingMonths: number;
}

export interface SavingsAccountPage {
  readonly accounts: readonly SavingsAccountSummary[];
  readonly page: number;
  readonly hasMore: boolean;
}

const REGISTER_COLUMNS = `
  savings_account_id, account_number, membership_id, membership_number,
  membership_status, client_id, client_number, full_name, phone,
  branch_id, branch_name, account_status, opened_on, balance,
  total_deposited, total_withdrawn, transaction_count, last_transaction_on,
  monthly_savings_minimum, savings_qualifying_months
` as const;

interface RegisterRow {
  savings_account_id: string;
  account_number: string;
  membership_id: string;
  membership_number: string;
  membership_status: string;
  client_id: string;
  client_number: string;
  full_name: string;
  phone: string;
  branch_id: string | null;
  branch_name: string | null;
  account_status: string;
  opened_on: string;
  balance: number | string | null;
  total_deposited: number | string | null;
  total_withdrawn: number | string | null;
  transaction_count: number | string | null;
  last_transaction_on: string | null;
  monthly_savings_minimum: number | string | null;
  savings_qualifying_months: number | null;
}

function toAccountSummary(row: RegisterRow): SavingsAccountSummary {
  return {
    id: row.savings_account_id,
    accountNumber: row.account_number,
    membershipId: row.membership_id,
    membershipNumber: row.membership_number,
    membershipStatus: row.membership_status,
    clientId: row.client_id,
    clientNumber: row.client_number,
    fullName: row.full_name,
    phone: row.phone,
    branchId: row.branch_id,
    branchName: row.branch_name,
    // A status the database allows and this build does not know about falls
    // back to `dormant` rather than being asserted: `dormant` restricts
    // nothing, so an unrecognised value cannot accidentally open a withdrawal
    // path. The CHECK constraint and `tests/unit/savings.test.ts` are what
    // keep the two vocabularies in step.
    status: isSavingsAccountStatus(row.account_status) ? row.account_status : 'dormant',
    openedOn: row.opened_on,
    balance: requiredAmount(row.balance),
    totalDeposited: requiredAmount(row.total_deposited),
    totalWithdrawn: requiredAmount(row.total_withdrawn),
    transactionCount: Number(row.transaction_count ?? 0),
    lastTransactionOn: row.last_transaction_on,
    monthlySavingsMinimum: requiredAmount(row.monthly_savings_minimum),
    savingsQualifyingMonths: row.savings_qualifying_months ?? 0,
  };
}

/**
 * The savings register, searched and filtered.
 *
 * Search covers the identifiers somebody at a counter would quote: the account
 * number, the membership number, the member's name and their client number.
 * Not the phone number and not the National Identification Number — the first
 * belongs to the client directory, which already searches it, and the second
 * is in no table this query reads, so no amount of typing into this box can
 * confirm one.
 *
 * The `compliance` filter is applied in TypeScript rather than in the query,
 * because "met this month's minimum" lives in `member_savings_contributions`
 * keyed by month and PostgREST cannot express the join. It filters the page
 * that was fetched, which is honest about what it is: a view of this page, not
 * a count of the business. `getSavingsSummary` is where the business-wide
 * figure comes from.
 */
export async function listSavingsAccounts(
  filter: SavingsSearchInput,
): Promise<SavingsAccountPage> {
  const supabase = await createSupabaseServerClient();

  const page = Math.max(1, filter.page ?? 1);
  const from = (page - 1) * SAVINGS_PAGE_SIZE;
  const to = from + SAVINGS_PAGE_SIZE;

  let query = supabase
    .from('savings_account_register')
    .select(REGISTER_COLUMNS)
    .order('account_number', { ascending: false })
    .range(from, to);

  const status = filter.status ?? 'all';
  if (status !== 'all') {
    query = query.eq('account_status', status);
  }

  const term =
    filter.query === null || filter.query === undefined
      ? ''
      : escapeSearchTerm(filter.query.trim());

  if (term !== '') {
    query = query.or(
      [
        `account_number.ilike.%${term}%`,
        `membership_number.ilike.%${term}%`,
        `full_name.ilike.%${term}%`,
        `client_number.ilike.%${term}%`,
      ].join(','),
    );
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not list savings accounts.', { code: error.code });
    throw mapDatabaseError(error, 'savings');
  }

  const rows = (data ?? []) as unknown as RegisterRow[];
  const hasMore = rows.length > SAVINGS_PAGE_SIZE;

  return {
    accounts: rows.slice(0, SAVINGS_PAGE_SIZE).map(toAccountSummary),
    page,
    hasMore,
  };
}

/** One savings account, or `null` when the caller may not see it. */
export async function getSavingsAccount(
  savingsAccountId: string,
): Promise<SavingsAccountSummary | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('savings_account_register')
    .select(REGISTER_COLUMNS)
    .eq('savings_account_id', savingsAccountId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a savings account.', { code: error.code });
    throw mapDatabaseError(error, 'savings');
  }

  return data === null ? null : toAccountSummary(data as unknown as RegisterRow);
}

/**
 * The savings account belonging to a client, if they have one.
 *
 * For the portal, where a member reads their own. One account per *membership*
 * and one live membership per client, so this resolves to at most one row —
 * and it resolves through the identity clause on `clients.profile_id`, so a
 * member asking for somebody else's client id gets nothing from the database
 * rather than nothing from a check written here.
 *
 * A client who rejoined has a second membership and therefore a second
 * account, so `maybeSingle` would raise rather than pick. The newest account
 * is the live one, which is the one a member is asking about.
 */
export async function getSavingsAccountForClient(
  clientId: string,
): Promise<SavingsAccountSummary | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('savings_account_register')
    .select(REGISTER_COLUMNS)
    .eq('client_id', clientId)
    .order('opened_on', { ascending: false })
    .order('account_number', { ascending: false })
    .limit(1);

  if (error !== null) {
    logger.warn('Could not read a client’s savings account.', { code: error.code });
    throw mapDatabaseError(error, 'savings');
  }

  const row = (data ?? [])[0];
  return row === undefined ? null : toAccountSummary(row as unknown as RegisterRow);
}

/** The savings account belonging to a membership, if it has one. */
export async function getSavingsAccountForMembership(
  membershipId: string,
): Promise<SavingsAccountSummary | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('savings_account_register')
    .select(REGISTER_COLUMNS)
    .eq('membership_id', membershipId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a membership’s savings account.', { code: error.code });
    throw mapDatabaseError(error, 'savings');
  }

  return data === null ? null : toAccountSummary(data as unknown as RegisterRow);
}

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

/** One line of a savings statement, with the balance after it. */
export interface StatementLine {
  readonly transactionId: string;
  readonly transactionNumber: string;
  readonly valueDate: string;
  readonly kind: SavingsTransactionKind;
  readonly description: string;
  readonly deposit: UgxAmount;
  readonly withdrawal: UgxAmount;
  /**
   * The row's own effect on the balance, signed.
   *
   * Carried through so a caller can derive the balance a period *opened* at
   * as `runningBalance - signedAmount` on its first row — from the database's
   * own figures rather than by summing the rows a second time.
   */
  readonly signedAmount: UgxAmount;
  readonly runningBalance: UgxAmount;
  readonly paymentMethod: PaymentMethod | null;
  readonly externalReference: string | null;
  readonly reversesTransactionNumber: string | null;
  readonly reversalReason: string | null;
  readonly recordedByLabel: string | null;
}

/**
 * A savings statement with a running balance.
 *
 * The running balance is computed in the database, over the whole account, and
 * the period filter is applied afterwards — so a statement for March opens at
 * the balance March actually opened at rather than at zero. Computing it here
 * instead would mean the figure on screen, the figure in a CSV and the figure
 * in a PDF were three renderings that each sorted the rows for themselves.
 */
export async function getSavingsStatement(
  input: SavingsStatementInput,
): Promise<readonly StatementLine[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('savings_statement', {
    p_savings_account_id: input.savingsAccountId,
    p_from: input.from === undefined || input.from === '' ? null : input.from,
    p_to: input.to === undefined || input.to === '' ? null : input.to,
  });

  if (error !== null) {
    logger.warn('Could not read a savings statement.', { code: error.code });
    throw mapDatabaseError(error, 'savings');
  }

  return (data ?? []).map((row) => ({
    transactionId: row.transaction_id,
    transactionNumber: row.transaction_number,
    valueDate: row.value_date,
    kind: isSavingsTransactionKind(row.kind) ? row.kind : 'deposit',
    description: row.description,
    deposit: requiredAmount(row.deposit),
    withdrawal: requiredAmount(row.withdrawal),
    signedAmount: requiredAmount(row.signed_amount),
    runningBalance: requiredAmount(row.running_balance),
    paymentMethod: (row.payment_method as PaymentMethod | null) ?? null,
    externalReference: row.external_reference,
    reversesTransactionNumber: row.reverses_transaction_number,
    reversalReason: row.reversal_reason,
    recordedByLabel: row.recorded_by_label,
  }));
}

// ---------------------------------------------------------------------------
// Contributions and qualification
// ---------------------------------------------------------------------------

export interface ContributionRow {
  readonly month: string;
  readonly contributed: UgxAmount;
  readonly deposited: UgxAmount;
  readonly reversed: UgxAmount;
  readonly depositCount: number;
  readonly lastDepositOn: string | null;
  readonly monthlyMinimum: UgxAmount;
  readonly meetsMinimum: boolean;
  readonly shortfall: UgxAmount;
  readonly surplus: UgxAmount;
}

/**
 * An account's contribution history, newest month first.
 *
 * A reversal is attributed to the month of the deposit it corrects, not the
 * month it was made in — so a deposit posted in March in error and reversed in
 * July stops counting for March and does not make July negative.
 */
export async function listContributionMonths(
  savingsAccountId: string,
): Promise<readonly ContributionRow[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('member_savings_contributions')
    .select(
      `contribution_month, contributed, deposited, reversed, deposit_count,
       last_deposit_on, monthly_savings_minimum, meets_minimum, shortfall, surplus`,
    )
    .eq('savings_account_id', savingsAccountId)
    .order('contribution_month', { ascending: false });

  if (error !== null) {
    logger.warn('Could not read contribution months.', { code: error.code });
    throw mapDatabaseError(error, 'savings');
  }

  return (data ?? []).map((row) => ({
    month: row.contribution_month ?? '',
    contributed: requiredAmount(row.contributed),
    deposited: requiredAmount(row.deposited),
    reversed: requiredAmount(row.reversed),
    depositCount: Number(row.deposit_count ?? 0),
    lastDepositOn: row.last_deposit_on,
    monthlyMinimum: requiredAmount(row.monthly_savings_minimum),
    meetsMinimum: row.meets_minimum === true,
    shortfall: requiredAmount(row.shortfall),
    surplus: requiredAmount(row.surplus),
  }));
}

export interface QualificationResult {
  readonly asOf: string;
  readonly monthlyMinimum: UgxAmount;
  readonly monthsRequired: number;
  readonly mustBeConsecutive: boolean;
  readonly qualifyingMonths: number;
  readonly longestConsecutiveMonths: number;
  readonly monthsRecorded: number;
  readonly monthsShort: number;
  readonly totalContributed: UgxAmount;
  readonly totalWithdrawn: UgxAmount;
  readonly balance: UgxAmount;
  readonly qualifies: boolean;
  readonly blockedReason: string | null;
}

/**
 * Whether a member has served their qualifying months, as of a date.
 *
 * `asOf` filters on `value_date`, so the answer to "did they qualify on 1
 * June" cannot be changed by a deposit made in July. Phase 3 will approve
 * member loans against this with the application date, and the snapshot it
 * took has to stay the snapshot it took.
 *
 * Returns `null` when the caller may not see the account: the function is
 * SECURITY INVOKER, so the policies filter the rows behind it and an account
 * the caller cannot read raises rather than leaking its existence.
 */
export async function getSavingsQualification(
  savingsAccountId: string,
  asOf?: string | null,
): Promise<QualificationResult | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('member_savings_qualification', {
    p_savings_account_id: savingsAccountId,
    p_as_of: asOf ?? null,
  });

  if (error !== null) {
    logger.warn('Could not read savings qualification.', { code: error.code });
    throw mapDatabaseError(error, 'savings');
  }

  const row = (data ?? [])[0];
  if (row === undefined) return null;

  return {
    asOf: row.as_of,
    monthlyMinimum: requiredAmount(row.monthly_minimum),
    monthsRequired: Number(row.months_required ?? 0),
    mustBeConsecutive: row.must_be_consecutive === true,
    qualifyingMonths: Number(row.qualifying_months ?? 0),
    longestConsecutiveMonths: Number(row.longest_consecutive_months ?? 0),
    monthsRecorded: Number(row.months_recorded ?? 0),
    monthsShort: Number(row.months_short ?? 0),
    totalContributed: requiredAmount(row.total_contributed),
    totalWithdrawn: requiredAmount(row.total_withdrawn),
    balance: requiredAmount(row.balance),
    qualifies: row.qualifies === true,
    blockedReason: row.blocked_reason,
  };
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

export interface WithdrawalRequestSummary {
  readonly id: string;
  readonly requestNumber: string;
  readonly savingsAccountId: string;
  readonly membershipId: string;
  readonly clientId: string;
  readonly amount: UgxAmount;
  readonly reason: string;
  readonly balanceAtRequest: UgxAmount;
  readonly status: WithdrawalStatus;
  readonly requestedByLabel: string;
  readonly requestedBy: string | null;
  readonly businessDate: string;
  readonly decidedByLabel: string | null;
  readonly decidedAt: string | null;
  readonly decisionNotes: string | null;
  readonly paidAt: string | null;
  readonly paidTransactionId: string | null;
  readonly cancelledAt: string | null;
  readonly cancellationReason: string | null;
}

const WITHDRAWAL_COLUMNS = `
  id, request_number, savings_account_id, membership_id, client_id, amount,
  reason, balance_at_request, status, requested_by, requested_by_label,
  business_date, decided_by_label, decided_at, decision_notes, paid_at,
  paid_transaction_id, cancelled_at, cancellation_reason
` as const;

interface WithdrawalRow {
  id: string;
  request_number: string;
  savings_account_id: string;
  membership_id: string;
  client_id: string;
  amount: number | string | null;
  reason: string;
  balance_at_request: number | string | null;
  status: string;
  requested_by: string | null;
  requested_by_label: string;
  business_date: string;
  decided_by_label: string | null;
  decided_at: string | null;
  decision_notes: string | null;
  paid_at: string | null;
  paid_transaction_id: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
}

function toWithdrawal(row: WithdrawalRow): WithdrawalRequestSummary {
  return {
    id: row.id,
    requestNumber: row.request_number,
    savingsAccountId: row.savings_account_id,
    membershipId: row.membership_id,
    clientId: row.client_id,
    amount: requiredAmount(row.amount),
    reason: row.reason,
    balanceAtRequest: requiredAmount(row.balance_at_request),
    // An unrecognised status falls back to `pending`, which is the state that
    // allows the least: a stale build must not render an unknown value as
    // `approved` and offer a payment button for it.
    status: isWithdrawalStatus(row.status) ? row.status : 'pending',
    requestedBy: row.requested_by,
    requestedByLabel: row.requested_by_label,
    businessDate: row.business_date,
    decidedByLabel: row.decided_by_label,
    decidedAt: row.decided_at,
    decisionNotes: row.decision_notes,
    paidAt: row.paid_at,
    paidTransactionId: row.paid_transaction_id,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
  };
}

export interface WithdrawalPage {
  readonly requests: readonly WithdrawalRequestSummary[];
  readonly page: number;
  readonly hasMore: boolean;
}

/** The withdrawal queue, defaulting to what is waiting for a decision. */
export async function listWithdrawalRequests(
  filter: WithdrawalSearchInput,
): Promise<WithdrawalPage> {
  const supabase = await createSupabaseServerClient();

  const page = Math.max(1, filter.page ?? 1);
  const from = (page - 1) * WITHDRAWALS_PAGE_SIZE;
  const to = from + WITHDRAWALS_PAGE_SIZE;

  let query = supabase
    .from('savings_withdrawal_requests')
    .select(WITHDRAWAL_COLUMNS)
    .order('request_number', { ascending: false })
    .range(from, to);

  const status = filter.status ?? 'pending';
  if (status !== 'all') {
    query = query.eq('status', status);
  }

  const term =
    filter.query === null || filter.query === undefined
      ? ''
      : escapeSearchTerm(filter.query.trim());

  if (term !== '') {
    query = query.ilike('request_number', `%${term}%`);
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not list withdrawal requests.', { code: error.code });
    throw mapDatabaseError(error, 'savings');
  }

  const rows = (data ?? []) as unknown as WithdrawalRow[];
  const hasMore = rows.length > WITHDRAWALS_PAGE_SIZE;

  return {
    requests: rows.slice(0, WITHDRAWALS_PAGE_SIZE).map(toWithdrawal),
    page,
    hasMore,
  };
}

export async function getWithdrawalRequest(
  requestId: string,
): Promise<WithdrawalRequestSummary | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('savings_withdrawal_requests')
    .select(WITHDRAWAL_COLUMNS)
    .eq('id', requestId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a withdrawal request.', { code: error.code });
    throw mapDatabaseError(error, 'savings');
  }

  return data === null ? null : toWithdrawal(data);
}

/** The live request on an account, if there is one. An account has at most one. */
export async function getLiveWithdrawal(
  savingsAccountId: string,
): Promise<WithdrawalRequestSummary | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('savings_withdrawal_requests')
    .select(WITHDRAWAL_COLUMNS)
    .eq('savings_account_id', savingsAccountId)
    .in('status', ['pending', 'approved'])
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read the live withdrawal.', { code: error.code });
    throw mapDatabaseError(error, 'savings');
  }

  return data === null ? null : toWithdrawal(data);
}

/** Every request against one account, newest first. */
export async function listAccountWithdrawals(
  savingsAccountId: string,
): Promise<readonly WithdrawalRequestSummary[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('savings_withdrawal_requests')
    .select(WITHDRAWAL_COLUMNS)
    .eq('savings_account_id', savingsAccountId)
    .order('request_number', { ascending: false });

  if (error !== null) {
    logger.warn('Could not list an account’s withdrawals.', { code: error.code });
    throw mapDatabaseError(error, 'savings');
  }

  return ((data ?? []) as unknown as WithdrawalRow[]).map(toWithdrawal);
}

// ---------------------------------------------------------------------------
// Fee receipts, consent and cards
// ---------------------------------------------------------------------------

export interface FeeReceiptSummary {
  readonly id: string;
  readonly receiptNumber: string;
  readonly membershipId: string;
  readonly clientId: string;
  readonly amount: UgxAmount;
  readonly paymentMethod: PaymentMethod;
  readonly externalReference: string | null;
  readonly status: MembershipFeeStatus;
  readonly businessDate: string;
  readonly receivedAt: string;
  readonly recordedByLabel: string;
  readonly journalEntryId: string | null;
  readonly reversedAt: string | null;
  readonly reversalReason: string | null;
}

export async function getMembershipFeeReceipt(
  membershipId: string,
): Promise<FeeReceiptSummary | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('membership_fee_receipts')
    .select(
      `id, receipt_number, membership_id, client_id, amount, payment_method,
       external_reference, status, business_date, received_at,
       recorded_by_label, journal_entry_id, reversed_at, reversal_reason`,
    )
    .eq('membership_id', membershipId)
    .eq('status', 'posted')
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a membership fee receipt.', { code: error.code });
    throw mapDatabaseError(error, 'membership');
  }

  if (data === null) return null;

  return {
    id: data.id,
    receiptNumber: data.receipt_number,
    membershipId: data.membership_id,
    clientId: data.client_id,
    amount: requiredAmount(data.amount),
    paymentMethod: data.payment_method as PaymentMethod,
    externalReference: data.external_reference,
    status: data.status as MembershipFeeStatus,
    businessDate: data.business_date,
    receivedAt: data.received_at,
    recordedByLabel: data.recorded_by_label,
    journalEntryId: data.journal_entry_id,
    reversedAt: data.reversed_at,
    reversalReason: data.reversal_reason,
  };
}

export interface ConsentRecord {
  readonly id: string;
  readonly policyVersion: string;
  readonly policyVersionId: string;
  readonly acceptedAt: string;
  readonly signatureName: string;
  readonly consentMethod: ConsentMethod;
  readonly verificationStatus: ConsentVerificationStatus;
  /** The *kind* of evidence, never the evidence itself: no digest is read here. */
  readonly evidenceReference: string | null;
  readonly verifiedAt: string | null;
  readonly verifiedByLabel: string | null;
  readonly acceptedPlace: string | null;
}

/**
 * A membership's acceptances, newest first.
 *
 * `evidence_digest` is deliberately not selected. It is the one column in the
 * table whose value is useful to an attacker and useless on a screen: a digest
 * of a one-time code or a signature path proves nothing to a person reading
 * the record, and shipping it to a browser would put it in a response body, a
 * cache and a debug log for no gain.
 */
export async function listMembershipConsent(
  membershipId: string,
): Promise<readonly ConsentRecord[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('membership_terms_acceptances')
    .select(
      `id, policy_version, policy_version_id, accepted_at, signature_name,
       consent_method, verification_status, evidence_reference, verified_at,
       verified_by_label, accepted_place`,
    )
    .eq('membership_id', membershipId)
    .order('accepted_at', { ascending: false });

  if (error !== null) {
    logger.warn('Could not list membership consent.', { code: error.code });
    throw mapDatabaseError(error, 'membership');
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    policyVersion: row.policy_version,
    policyVersionId: row.policy_version_id,
    acceptedAt: row.accepted_at,
    signatureName: row.signature_name,
    consentMethod: row.consent_method as ConsentMethod,
    verificationStatus: row.verification_status as ConsentVerificationStatus,
    evidenceReference: row.evidence_reference,
    verifiedAt: row.verified_at,
    verifiedByLabel: row.verified_by_label,
    acceptedPlace: row.accepted_place,
  }));
}

export interface MembershipCardSummary {
  readonly id: string;
  readonly cardNumber: string;
  readonly membershipId: string;
  readonly printedName: string;
  readonly verificationCode: string;
  readonly status: MembershipCardStatus;
  readonly issueReason: MembershipCardReason;
  readonly issuedOn: string;
  readonly issuedByLabel: string;
  readonly supersededAt: string | null;
}

/** A membership's cards, the current one first. */
export async function listMembershipCards(
  membershipId: string,
): Promise<readonly MembershipCardSummary[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('membership_cards')
    .select(
      `id, card_number, membership_id, printed_name, verification_code, status,
       issue_reason, issued_on, issued_by_label, superseded_at`,
    )
    .eq('membership_id', membershipId)
    .order('issued_on', { ascending: false })
    .order('card_number', { ascending: false });

  if (error !== null) {
    logger.warn('Could not list membership cards.', { code: error.code });
    throw mapDatabaseError(error, 'membership');
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    cardNumber: row.card_number,
    membershipId: row.membership_id,
    printedName: row.printed_name,
    verificationCode: row.verification_code,
    status: row.status as MembershipCardStatus,
    issueReason: row.issue_reason as MembershipCardReason,
    issuedOn: row.issued_on,
    issuedByLabel: row.issued_by_label,
    supersededAt: row.superseded_at,
  }));
}

// ---------------------------------------------------------------------------
// The dashboard figure
// ---------------------------------------------------------------------------

export interface SavingsSummary {
  readonly accountsOpen: number;
  readonly membersSaving: number;
  /** The figure that must equal the `2100 Member Savings` ledger balance. */
  readonly totalLiability: UgxAmount;
  readonly depositsInPeriod: UgxAmount;
  readonly withdrawalsInPeriod: UgxAmount;
  readonly depositsCount: number;
  readonly withdrawalsCount: number;
  readonly pendingWithdrawalRequests: number;
  readonly pendingWithdrawalValue: UgxAmount;
  readonly membersMeetingMinimum: number;
}

/**
 * The savings position, for a dashboard.
 *
 * `null` when the caller does not hold `savings:view_reports`, rather than a
 * thrown error: a Secretary opening the dashboard should see the panels they
 * are entitled to and not a failed page. The capability is checked inside
 * `savings_summary` — this function cannot be talked into returning the figure
 * by being called differently.
 */
export async function getSavingsSummary(
  from?: string | null,
  to?: string | null,
): Promise<SavingsSummary | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('savings_summary', {
    p_from: from ?? null,
    p_to: to ?? null,
  });

  if (error !== null) {
    // A refusal from the capability check is an expected outcome here, not a
    // fault, so it is reported at debug and the panel is simply absent.
    logger.debug('The savings summary was not available to this caller.', {
      code: error.code,
    });
    return null;
  }

  const row = (data ?? [])[0];
  if (row === undefined) return null;

  return {
    accountsOpen: Number(row.accounts_open ?? 0),
    membersSaving: Number(row.members_saving ?? 0),
    totalLiability: requiredAmount(row.total_liability),
    depositsInPeriod: requiredAmount(row.deposits_in_period),
    withdrawalsInPeriod: requiredAmount(row.withdrawals_in_period),
    depositsCount: Number(row.deposits_count ?? 0),
    withdrawalsCount: Number(row.withdrawals_count ?? 0),
    pendingWithdrawalRequests: Number(row.pending_withdrawal_requests ?? 0),
    pendingWithdrawalValue: requiredAmount(row.pending_withdrawal_value),
    membersMeetingMinimum: Number(row.members_meeting_minimum ?? 0),
  };
}

/**
 * Whether this client holds a live loan.
 *
 * Read for the withdrawal screen, so it can say why a withdrawal is blocked
 * before somebody fills in the form. `request_savings_withdrawal` asks the
 * same question again at the moment it matters.
 */
export async function clientHasLiveLoan(clientId: string): Promise<boolean> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('client_has_live_loan', {
    p_client_id: clientId,
  });

  if (error !== null) {
    logger.warn('Could not check for a live loan.', { code: error.code });
    throw mapDatabaseError(error, 'savings');
  }

  return data === true;
}

// ---------------------------------------------------------------------------
// The witness picker
// ---------------------------------------------------------------------------

export interface WitnessCandidate {
  readonly profileId: string;
  readonly fullName: string;
}

/**
 * The members of staff who could witness an acceptance.
 *
 * Active profiles only, and never the person asking — because
 * `membership_terms_acceptances_guard` refuses a witness who is the recorder,
 * and offering a name the database will reject is worse than offering a
 * shorter list. The guard is still the control: this list is a convenience,
 * and a caller who posts their own id is refused there.
 *
 * It reads `profiles`, where the select policy already requires `users:view`
 * — which is held by exactly the roles that hold `membership:create`. So a
 * caller who may enrol can see the staff list, and nothing else needs to say
 * so.
 */
export async function listWitnessCandidates(
  excludeProfileId: string,
): Promise<readonly WitnessCandidate[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('status', 'active')
    .neq('id', excludeProfileId)
    .order('full_name', { ascending: true })
    .limit(200);

  if (error !== null) {
    logger.warn('Could not list witness candidates.', { code: error.code });
    throw mapDatabaseError(error, 'user');
  }

  return (data ?? []).map((row) => ({
    profileId: row.id,
    fullName: row.full_name,
  }));
}
