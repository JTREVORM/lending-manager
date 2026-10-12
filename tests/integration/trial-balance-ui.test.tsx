import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { TrialBalance } from '@/components/finance/trial-balance';
import { toUgx } from '@/lib/domain/money';
import {
  summariseTrialBalance,
  type TrialBalanceAccount,
} from '@/lib/domain/trial-balance';

/**
 * The trial balance screen.
 *
 * ## What these protect
 *
 * A trial balance is read for one reason: to see that the books foot. The
 * ways this screen could fail at that are specific, and each has a test:
 *
 *   - a net balance rendered as a negative figure in the wrong column, which
 *     is what a trial balance's two columns exist to prevent;
 *   - the gross movement and the net balance shown as if they were the same
 *     figure;
 *   - totals that do not appear at all on a phone, where the table is
 *     replaced by cards;
 *   - an out-of-balance ledger shown quietly, or rounded away;
 *   - a figure computed on this screen rather than read from the view.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/finance/trial-balance',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const account = (
  overrides: Partial<TrialBalanceAccount> & Pick<TrialBalanceAccount, 'code' | 'name'>,
): TrialBalanceAccount => ({
  accountType: 'asset',
  normalSide: 'debit',
  totalDebit: toUgx(0),
  totalCredit: toUgx(0),
  ...overrides,
});

/**
 * Sound books: 3,100,000 of movement either way, 2,500,000 of balances either
 * way, with Cash at Hand used on both sides so the two pairs of columns are
 * genuinely different figures.
 */
const SOUND = summariseTrialBalance([
  account({
    code: '1000',
    name: 'Cash at Hand',
    totalDebit: toUgx(2_100_000),
    totalCredit: toUgx(600_000),
  }),
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
  account({ code: '9000', name: 'Suspense' }),
]);

const BROKEN = summariseTrialBalance([
  account({ code: '1000', name: 'Cash at Hand', totalDebit: toUgx(1_000_001) }),
  account({
    code: '3000',
    name: 'Owner Capital',
    accountType: 'equity',
    normalSide: 'credit',
    totalCredit: toUgx(1_000_000),
  }),
]);

describe('the trial balance table', () => {
  it('shows the seven columns a trial balance is read across', () => {
    render(<TrialBalance summary={SOUND} />);

    for (const heading of [
      'Code',
      'Account',
      'Type',
      'Debits (UGX)',
      'Credits (UGX)',
      'Debit balance (UGX)',
      'Credit balance (UGX)',
    ]) {
      expect(
        screen.getAllByRole('columnheader', { name: heading }).length,
        heading,
      ).toBeGreaterThan(0);
    }
  });

  it('names each account by code, name and type', () => {
    render(<TrialBalance summary={SOUND} />);

    expect(screen.getAllByText('1000').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Cash at Hand').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Asset').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Income').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Equity').length).toBeGreaterThan(0);
  });

  it('shows movement and net balance as different figures on one row', () => {
    // Cash at Hand: 2,100,000 debited, 600,000 credited, 1,500,000 held. A
    // screen that showed only the net would say 1,500,000 moved.
    render(<TrialBalance summary={SOUND} />);

    expect(screen.getAllByText('2,100,000').length).toBeGreaterThan(0);
    expect(screen.getAllByText('600,000').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1,500,000').length).toBeGreaterThan(0);
  });

  it('never renders a negative figure in a balance column', () => {
    // The reason a trial balance has two columns. A credit balance of
    // 2,000,000 is `2,000,000` in the credit column, not `-2,000,000` in the
    // debit column.
    render(<TrialBalance summary={SOUND} />);

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/-\s?[\d,]+/);
  });

  it('keeps an account with no movement as a row', () => {
    // The chart does not shrink because a month was quiet, and a reader
    // comparing two printings line by line needs the rows to be the same.
    render(<TrialBalance summary={SOUND} />);

    expect(screen.getAllByText('Suspense').length).toBeGreaterThan(0);
    expect(SOUND.accountCount).toBe(5);
    expect(SOUND.accountsWithMovement).toBe(4);
  });
});

describe('the foot of the statement', () => {
  it('states all four totals and both differences', () => {
    render(<TrialBalance summary={SOUND} />);

    for (const label of [
      'Total debits',
      'Total credits',
      'Debit balances',
      'Credit balances',
      'Difference on movement',
      'Difference on balances',
    ]) {
      expect(screen.getByText(label), label).toBeInTheDocument();
    }
  });

  it('foots both pairs of columns to the same figure', () => {
    render(<TrialBalance summary={SOUND} />);

    // 3,100,000 of movement either way; 2,500,000 of balances either way.
    expect(screen.getAllByText('UGX 3,100,000')).toHaveLength(2);
    expect(screen.getAllByText('UGX 2,500,000')).toHaveLength(2);
  });

  it('shows the totals at every width, not only where the table is', () => {
    // The report table is `hidden md:block` and becomes cards below that, so
    // a trial balance whose totals lived only in its `<tfoot>` would be a
    // trial balance nobody could check on a phone.
    render(<TrialBalance summary={SOUND} />);

    const panel = screen.getByText('The foot of the statement').closest('div');
    expect(panel).not.toBeNull();
    expect(panel?.className ?? '').not.toContain('hidden');
  });

  it('says in words that it balances, not only in colour', () => {
    render(<TrialBalance summary={SOUND} />);

    expect(screen.getByText('Balanced')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports a one-shilling difference loudly, and does not round it away', () => {
    render(<TrialBalance summary={BROKEN} />);

    expect(screen.getByText('Out of balance')).toBeInTheDocument();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/does not balance/i);
    expect(alert).toHaveTextContent(/UGX 1\b/);
    expect(alert).toHaveTextContent(/Do not report from this screen/i);
  });

  it('counts the accounts with movement beside the size of the chart', () => {
    render(<TrialBalance summary={SOUND} />);

    expect(screen.getByText(/4 of 5 accounts have movement/i)).toBeInTheDocument();
  });
});

/**
 * The properties that cannot be seen by rendering.
 */
describe('what the trial balance is, structurally', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

  it('reads the view and nothing else', () => {
    const data = read('lib/data/finance.ts');

    expect(data).toContain("from('trial_balance')");
    // No second question about the same figures: the loader does not touch
    // journal lines, entries or the balances view.
    const loader =
      /export async function getTrialBalance\(\)[\s\S]*?\n}/.exec(data)?.[0] ?? '';
    expect(loader).not.toContain('journal_lines');
    expect(loader).not.toContain('journal_entries');
    expect(loader).not.toContain('ledger_account_balances');
  });

  it('returns nothing rather than an empty statement when the read fails', () => {
    // Two zero totals and no rows would read as "the books are empty and
    // balanced", which is the one answer this screen must never give by
    // accident.
    const data = read('lib/data/finance.ts');
    const loader =
      /export async function getTrialBalance\(\)[\s\S]*?\n}/.exec(data)?.[0] ?? '';

    expect(loader).toMatch(/if \(error !== null\)[\s\S]*?return null;/);
  });

  it('is read-only: the page has no form, action or mutation', () => {
    const page = read('app/(app)/finance/trial-balance/page.tsx');

    expect(page).not.toContain("'use server'");
    expect(page).not.toContain('<form');
    expect(page).not.toContain('action=');
    expect(page).toContain("guardPermission(ROUTES.trialBalance, 'ledger:view')");
  });

  it('offers no filter it cannot honour', () => {
    // The view has no date and no branch dimension, so the page has no date
    // or branch control. A control that narrowed nothing would be worse than
    // no control.
    const page = read('app/(app)/finance/trial-balance/page.tsx');

    expect(page).not.toContain('ReportFilters');
    expect(page).not.toContain('searchParams');
    expect(page).toMatch(/no date filter and no branch filter/i);
  });

  it('builds its downloads from the same fields the screen renders', () => {
    const route = read('app/(app)/finance/trial-balance/export/route.ts');
    const view = read('components/finance/trial-balance.tsx');

    expect(route).toContain('trialBalanceFields');
    expect(view).toContain('trialBalanceFields');
  });

  it('guards its export route with the capability the page requires', () => {
    // A download is a separate request to a URL that can be typed, copied, or
    // kept after a role changes.
    const route = read('app/(app)/finance/trial-balance/export/route.ts');

    expect(route).toContain("guardExport(['ledger:view'])");
    expect(route).toMatch(/if \(!guard\.ok\) return guard\.response;/);
  });

  it('reuses the reporting pipeline rather than copying it', () => {
    const route = read('app/(app)/finance/trial-balance/export/route.ts');

    for (const shared of [
      'guardExport',
      'csvResponse',
      'csvColumns',
      'toCsv',
      'renderReportPdf',
      'letterheadMark',
      'pdfResponse',
    ]) {
      expect(route, shared).toContain(shared);
    }
  });

  it('refuses to issue a document when the ledger could not be read', () => {
    const route = read('app/(app)/finance/trial-balance/export/route.ts');

    expect(route).toMatch(/summary === null[\s\S]*?status: 503/);
  });
});
