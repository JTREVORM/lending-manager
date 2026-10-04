import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DelinquencyBadge } from '@/components/delinquency/delinquency-badge';
import { DelinquencyPanel } from '@/components/delinquency/delinquency-panel';
import { OverdueList } from '@/components/delinquency/overdue-list';
import { PenaltyCard } from '@/components/delinquency/penalty-card';
import { PortalLoanPosition } from '@/components/delinquency/portal-loan-position';
import { PaymentForm } from '@/components/payments/payment-form';
import { toBusinessDate } from '@/lib/domain/datetime';
import { toUgx } from '@/lib/domain/money';
import { DELINQUENCY_STATES } from '@/lib/domain/delinquency';
import type { LoanDelinquency, DelinquentLoanRow } from '@/lib/data/delinquency';
import type { PaymentObligation } from '@/lib/domain/payment';

/**
 * The Phase 7 screens.
 *
 * Browser-level layout verification needs a live Supabase instance, which this
 * environment cannot run. These assertions cover what can be checked without
 * one, and for a delinquency screen the most important are:
 *
 *   - the demand is **itemised**, not summarised as "payment doubled", which
 *     stops being true the moment two collections are missed or one is partly
 *     covered;
 *   - a count of missed collections is never presented as a count of days;
 *   - a **pending** charge is labelled as pending, because it is not in the
 *     balance yet;
 *   - a borrower is told what they owe and why, in words, without being shown
 *     anything about the business's own handling of their account;
 *   - and colour never carries the meaning.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/overdue',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/payments/actions', () => ({
  recordPaymentAction: vi.fn(),
  reversePaymentAction: vi.fn(),
  mintIdempotencyKey: vi.fn(),
}));

const TIMEZONE = 'Africa/Kampala';

/** A loan one collection behind: UGX 4,000 missed, UGX 4,000 due today. */
function position(overrides: Partial<LoanDelinquency> = {}): LoanDelinquency {
  return {
    loanId: 'loan-1',
    loanNumber: 'LN260001',
    clientId: 'client-1',
    loanStatus: 'active',

    businessDate: toBusinessDate('2026-11-03'),
    installmentCount: 30,
    firstDueDate: toBusinessDate('2026-11-02'),
    scheduledCompletionDate: toBusinessDate('2026-12-01'),
    scheduledTotal: toUgx(120_000),
    scheduledDueToDate: toUgx(8_000),
    paidAgainstSchedule: toUgx(0),

    arrearsAmount: toUgx(4_000),
    dueToday: toUgx(4_000),
    currentDue: toUgx(8_000),
    missedInstallmentCount: 1,
    oldestUnpaidDueDate: toBusinessDate('2026-11-02'),
    oldestPastDueDate: toBusinessDate('2026-11-02'),
    daysPastDue: 1,

    graceDays: 3,
    graceEndDate: toBusinessDate('2026-12-04'),
    penaltyEffectiveDate: toBusinessDate('2026-12-05'),
    pastFinalDueDate: false,
    withinGracePeriod: false,

    contractualOutstanding: toUgx(120_000),
    penaltyAmount: toUgx(0),
    penaltyPaid: toUgx(0),
    penaltyRemaining: toUgx(0),
    totalOutstanding: toUgx(120_000),

    penaltyApplied: false,
    penaltyEligible: false,
    penaltyProjectedAmount: toUgx(0),
    penaltyId: null,
    penaltyBasisAmount: null,
    penaltyAppliedEffectiveDate: null,
    penaltyRateBps: 5_000,
    penaltyBasisAsOfGraceEnd: toUgx(0),

    state: 'in_arrears',
    reconciles: true,
    reconciliationProblem: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The badge
// ---------------------------------------------------------------------------

describe('the delinquency badge', () => {
  it('states every condition in words', () => {
    for (const state of DELINQUENCY_STATES) {
      const { unmount } = render(<DelinquencyBadge state={state} />);
      // Something readable, never an empty pill whose colour is the message.
      expect(screen.getByText(/\w/).textContent?.trim().length).toBeGreaterThan(2);
      unmount();
    }
  });

  it('carries the predicate behind the label, for somebody who is unsure', () => {
    render(<DelinquencyBadge state="expired_unpaid" />);

    const badge = screen.getByText('Expired, unpaid');

    expect(badge).toHaveAttribute('title');
    expect(badge.getAttribute('title')).toMatch(/grace period/i);
  });

  it('never says a borrower has defaulted', () => {
    // "Defaulted" and "delinquent" are judgements about a person. These
    // labels describe the state of an account.
    for (const state of DELINQUENCY_STATES) {
      const { unmount } = render(<DelinquencyBadge state={state} />);
      expect(document.body.textContent ?? '').not.toMatch(/default|delinquen|bad debt/i);
      unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// The staff panel
// ---------------------------------------------------------------------------

describe('the delinquency panel', () => {
  it('itemises the demand instead of calling it doubled', () => {
    render(<DelinquencyPanel position={position()} />);

    // The three lines the specification asks for, by name.
    expect(screen.getByText('Previous unpaid')).toBeInTheDocument();
    expect(screen.getByText('Due today')).toBeInTheDocument();
    expect(screen.getByText('Due now')).toBeInTheDocument();

    // And the arithmetic is visible rather than asserted: 4,000 + 4,000.
    expect(screen.getAllByText(/UGX\s*4,000/)).toHaveLength(2);
    expect(screen.getByText(/UGX\s*8,000/)).toBeInTheDocument();

    // Never the shortcut that stops being true on the second miss.
    expect(document.body.textContent ?? '').not.toMatch(/doubled|double payment/i);
  });

  it('stays correct with two missed collections', () => {
    render(
      <DelinquencyPanel
        position={position({
          arrearsAmount: toUgx(8_000),
          currentDue: toUgx(12_000),
          missedInstallmentCount: 2,
          daysPastDue: 2,
        })}
      />,
    );

    expect(screen.getByText(/UGX\s*8,000/)).toBeInTheDocument();
    expect(screen.getByText(/UGX\s*12,000/)).toBeInTheDocument();
    expect(screen.getByText('2 days')).toBeInTheDocument();
  });

  it('reports missed collections and days late as different figures', () => {
    // An every-3-days loan three collections behind is nine days late.
    render(
      <DelinquencyPanel
        position={position({
          arrearsAmount: toUgx(12_000),
          currentDue: toUgx(12_000),
          dueToday: toUgx(0),
          missedInstallmentCount: 3,
          daysPastDue: 9,
        })}
      />,
    );

    expect(screen.getByText('Collections missed')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Days late')).toBeInTheDocument();
    expect(screen.getByText('9 days')).toBeInTheDocument();

    // The count is not labelled as days anywhere.
    const missed = screen.getByText('Collections missed').parentElement;
    expect(missed?.textContent).not.toMatch(/day/i);
  });

  it('says plainly when nothing is due', () => {
    render(
      <DelinquencyPanel
        position={position({
          arrearsAmount: toUgx(0),
          dueToday: toUgx(0),
          currentDue: toUgx(0),
          missedInstallmentCount: 0,
          daysPastDue: 0,
          oldestPastDueDate: null,
          state: 'current',
        })}
      />,
    );

    expect(
      screen.getByText(/Nothing is due today or earlier on this loan/i),
    ).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
  });

  it('shows the contract and the penalty apart, and the total', () => {
    render(
      <DelinquencyPanel
        position={position({
          penaltyApplied: true,
          penaltyAmount: toUgx(50_000),
          penaltyRemaining: toUgx(50_000),
          contractualOutstanding: toUgx(100_000),
          totalOutstanding: toUgx(150_000),
          state: 'penalty_due',
        })}
      />,
    );

    expect(screen.getByText('Contract outstanding')).toBeInTheDocument();
    expect(screen.getByText('Penalty outstanding')).toBeInTheDocument();
    expect(screen.getByText('Total outstanding')).toBeInTheDocument();

    expect(screen.getByText(/UGX\s*100,000/)).toBeInTheDocument();
    expect(screen.getAllByText(/UGX\s*50,000/).length).toBeGreaterThan(0);
    expect(screen.getByText(/UGX\s*150,000/)).toBeInTheDocument();
    expect(screen.getByText('Penalty due')).toBeInTheDocument();
  });

  it('says there is no penalty when there is none, rather than showing zero', () => {
    render(<DelinquencyPanel position={position()} />);

    expect(screen.getByText('None charged')).toBeInTheDocument();
    expect(screen.getByText(/No expiry penalty on this loan/i)).toBeInTheDocument();
  });

  it('labels a pending charge as pending and keeps it out of the balance', () => {
    render(
      <DelinquencyPanel
        position={position({
          pastFinalDueDate: true,
          penaltyEligible: true,
          penaltyProjectedAmount: toUgx(50_000),
          penaltyBasisAsOfGraceEnd: toUgx(100_000),
          contractualOutstanding: toUgx(100_000),
          totalOutstanding: toUgx(100_000),
          graceEndDate: toBusinessDate('2026-12-04'),
          state: 'expired_unpaid',
        })}
      />,
    );

    expect(screen.getByText('A penalty is due on this loan')).toBeInTheDocument();
    expect(
      screen.getByText(/will be added to this loan the moment any payment is recorded/i),
    ).toBeInTheDocument();
    // Explicit about the balance below not including it yet.
    expect(
      screen.getByText(/not included in the balance below yet/i),
    ).toBeInTheDocument();
    // And the balance panel says no charge has been made.
    expect(screen.getByText('None charged')).toBeInTheDocument();
  });

  it('explains the grace period while the loan is inside it', () => {
    render(
      <DelinquencyPanel
        position={position({
          pastFinalDueDate: true,
          withinGracePeriod: true,
          state: 'grace_period',
        })}
      />,
    );

    expect(screen.getByText(/inside its 3-day grace period/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Settling in full before then means no penalty/i),
    ).toBeInTheDocument();
  });

  it('warns loudly, and says not to quote the figures, when the position does not hold', () => {
    render(
      <DelinquencyPanel
        position={position({
          reconciles: false,
          reconciliationProblem: 'current due is not arrears plus due today.',
        })}
      />,
    );

    expect(
      screen.getByText('This delinquency position does not hold together'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Do not quote any figure on this panel/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Report it immediately/i)).toBeInTheDocument();
  });

  it('dates every figure, so nobody reads a stale panel as today"s', () => {
    render(<DelinquencyPanel position={position()} />);

    expect(screen.getByText(/As at 3 Nov 2026/i)).toBeInTheDocument();
  });

  it('labels each figure for a screen reader', () => {
    const { container } = render(<DelinquencyPanel position={position()} />);

    // Description lists, so each number is announced with what it means.
    expect(container.querySelectorAll('dl').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('dt').length).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// The penalty card
// ---------------------------------------------------------------------------

describe('the penalty card', () => {
  const PENALTY = {
    penaltyId: 'penalty-1',
    loanId: 'loan-1',
    penaltyType: 'expiry_penalty',
    finalDueDate: toBusinessDate('2026-12-01'),
    graceDays: 3,
    graceEndDate: toBusinessDate('2026-12-04'),
    effectiveDate: toBusinessDate('2026-12-05'),
    basisAmount: toUgx(100_000),
    penaltyRateBps: 5_000,
    penaltyAmount: toUgx(50_000),
    allocatedAmount: toUgx(0),
    remainingAmount: toUgx(50_000),
    triggerRule: 'grace_period_expired',
    appliedAt: '2026-12-05T07:00:00Z',
  };

  it('shows the whole derivation, so the charge can be explained', () => {
    render(<PenaltyCard penalty={PENALTY} timeZone={TIMEZONE} />);

    expect(screen.getByText('Charge')).toBeInTheDocument();
    expect(screen.getByText('Charged on balance of')).toBeInTheDocument();
    expect(screen.getByText('Rate')).toBeInTheDocument();
    expect(screen.getByText('Final collection was due')).toBeInTheDocument();
    expect(screen.getByText('Grace period')).toBeInTheDocument();
    expect(screen.getByText('Charge took effect')).toBeInTheDocument();

    expect(screen.getAllByText(/UGX\s*50,000/).length).toBeGreaterThan(0);
    // Twice: the figure, and the sentence explaining what it is.
    expect(screen.getAllByText(/UGX\s*100,000/).length).toBe(2);
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('says the basis is the balance at the deadline, not today"s', () => {
    // The figure people get wrong, so it gets a sentence of its own.
    render(<PenaltyCard penalty={PENALTY} timeZone={TIMEZONE} />);

    expect(
      screen.getByText(/is what this loan owed when its grace period ran out/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/not what it owes now/i)).toBeInTheDocument();
  });

  it('says the charge was applied by the system and cannot be edited', () => {
    render(<PenaltyCard penalty={PENALTY} timeZone={TIMEZONE} />);

    expect(
      screen.getByText(/applied by the system from the loan’s own agreed terms/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/cannot be edited, and is recorded once/i),
    ).toBeInTheDocument();
  });

  it('offers no control to change or waive it', () => {
    render(<PenaltyCard penalty={PENALTY} timeZone={TIMEZONE} />);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    // No waiver either: that is a commercial feature nobody has asked for,
    // and a half-built one would be worse than none.
    expect(document.body.textContent ?? '').not.toMatch(/waive|waiver|write off/i);
  });

  it('says when it has been paid off', () => {
    render(
      <PenaltyCard
        penalty={{
          ...PENALTY,
          allocatedAmount: toUgx(50_000),
          remainingAmount: toUgx(0),
        }}
        timeZone={TIMEZONE}
      />,
    );

    expect(screen.getByText('Paid in full')).toBeInTheDocument();
  });

  it('shows what is outstanding when it is not', () => {
    render(<PenaltyCard penalty={PENALTY} timeZone={TIMEZONE} />);

    expect(screen.getByText(/UGX\s*50,000 outstanding/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The overdue list
// ---------------------------------------------------------------------------

describe('the overdue list', () => {
  const ROWS: readonly DelinquentLoanRow[] = [
    {
      ...position({
        loanId: 'loan-1',
        loanNumber: 'LN260001',
        state: 'penalty_due',
        penaltyApplied: true,
        penaltyAmount: toUgx(50_000),
        penaltyRemaining: toUgx(50_000),
        contractualOutstanding: toUgx(100_000),
        totalOutstanding: toUgx(150_000),
        currentDue: toUgx(100_000),
        arrearsAmount: toUgx(100_000),
        dueToday: toUgx(0),
        daysPastDue: 12,
        missedInstallmentCount: 25,
      }),
      clientName: 'Amina Nakato',
      clientNumber: 'CL26001',
      clientPhone: '+256700000001',
    },
    {
      ...position({
        loanId: 'loan-2',
        loanNumber: 'LN260002',
        clientId: 'client-2',
        state: 'in_arrears',
      }),
      clientName: 'Joseph Okello',
      clientNumber: 'CL26002',
      clientPhone: '+256700000002',
    },
  ];

  const COUNTS = {
    current: 40,
    due_today: 3,
    in_arrears: 7,
    grace_period: 2,
    expired_unpaid: 1,
    penalty_due: 4,
    cleared: 19,
  };

  it('shows who to call, the number to call, and how much to ask for', () => {
    render(
      <OverdueList
        loans={ROWS}
        page={1}
        hasMore={false}
        counts={COUNTS}
        businessDate="2026-11-03"
      />,
    );

    expect(screen.getAllByText('Amina Nakato').length).toBeGreaterThan(0);
    expect(screen.getAllByText('+256700000001').length).toBeGreaterThan(0);
    expect(screen.getAllByText('LN260001').length).toBeGreaterThan(0);
    // Due now, which is the figure a collection officer asks for.
    expect(screen.getAllByText(/UGX\s*100,000/).length).toBeGreaterThan(0);
  });

  it('makes the phone number callable', () => {
    const { container } = render(
      <OverdueList
        loans={ROWS}
        page={1}
        hasMore={false}
        counts={COUNTS}
        businessDate="2026-11-03"
      />,
    );

    const links = container.querySelectorAll('a[href^="tel:"]');
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]?.getAttribute('href')).toBe('tel:+256700000001');
  });

  it('separates missed collections from days late in its columns', () => {
    render(
      <OverdueList
        loans={ROWS}
        page={1}
        hasMore={false}
        counts={COUNTS}
        businessDate="2026-11-03"
      />,
    );

    const table = screen.getByRole('table');

    expect(within(table).getByText('Missed')).toBeInTheDocument();
    expect(within(table).getByText('Days late')).toBeInTheDocument();
    // 25 collections, 12 days: two different numbers in two columns.
    expect(within(table).getByText('25')).toBeInTheDocument();
    expect(within(table).getByText('12')).toBeInTheDocument();
  });

  it('breaks out a penalty inside the outstanding figure', () => {
    render(
      <OverdueList
        loans={ROWS}
        page={1}
        hasMore={false}
        counts={COUNTS}
        businessDate="2026-11-03"
      />,
    );

    expect(screen.getByText(/incl\. UGX\s*50,000 penalty/)).toBeInTheDocument();
  });

  it('flags a pending charge as pending', () => {
    const pending: readonly DelinquentLoanRow[] = [
      {
        ...ROWS[0]!,
        penaltyApplied: false,
        penaltyAmount: toUgx(0),
        penaltyRemaining: toUgx(0),
        penaltyEligible: true,
        penaltyProjectedAmount: toUgx(50_000),
        totalOutstanding: toUgx(100_000),
        state: 'expired_unpaid',
      },
    ];

    render(
      <OverdueList
        loans={pending}
        page={1}
        hasMore={false}
        counts={COUNTS}
        businessDate="2026-11-03"
      />,
    );

    expect(screen.getByText(/UGX\s*50,000 penalty pending/)).toBeInTheDocument();
  });

  it('counts the states it is watching', () => {
    render(
      <OverdueList
        loans={ROWS}
        page={1}
        hasMore={false}
        counts={COUNTS}
        businessDate="2026-11-03"
      />,
    );

    // The labels appear in the summary and again in the filter's options, so
    // the counts are read from the summary list itself.
    const summary = screen.getByText(/As at 3 Nov 2026/i).closest('div');
    expect(summary).not.toBeNull();

    const counts = within(summary as HTMLElement);

    expect(counts.getByText('Penalty due')).toBeInTheDocument();
    expect(counts.getByText('4')).toBeInTheDocument();
    expect(counts.getByText('In arrears')).toBeInTheDocument();
    expect(counts.getByText('7')).toBeInTheDocument();
    expect(counts.getByText('Expired, unpaid')).toBeInTheDocument();
    expect(counts.getByText('Grace period')).toBeInTheDocument();
  });

  it('dates the list', () => {
    render(
      <OverdueList
        loans={ROWS}
        page={1}
        hasMore={false}
        counts={COUNTS}
        businessDate="2026-11-03"
      />,
    );

    expect(
      screen.getByText(/As at 3 Nov 2026, in the business timezone/i),
    ).toBeInTheDocument();
  });

  it('offers the filters the collections team needs', () => {
    render(
      <OverdueList
        loans={ROWS}
        page={1}
        hasMore={false}
        counts={COUNTS}
        businessDate="2026-11-03"
      />,
    );

    expect(screen.getByLabelText(/^State$/)).toBeInTheDocument();
    expect(screen.getByLabelText(/At least this many days late/)).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Search overdue loans by loan number/),
    ).toBeInTheDocument();
  });

  it('offers no filter that would hide a borrower behind on payments', () => {
    render(
      <OverdueList
        loans={ROWS}
        page={1}
        hasMore={false}
        counts={COUNTS}
        businessDate="2026-11-03"
      />,
    );

    // The state filter defaults to everything behind, and cannot be used to
    // suppress arrears — only to narrow to one kind of lateness.
    const select = screen.getByLabelText(/^State$/);
    expect(select).toHaveValue('all');
    expect(within(select).getByText('Everything behind')).toBeInTheDocument();
  });

  it('distinguishes an empty filter result from nothing being overdue', () => {
    render(
      <OverdueList
        loans={[]}
        page={1}
        hasMore={false}
        counts={COUNTS}
        businessDate="2026-11-03"
      />,
    );

    expect(
      screen.getByText(/not the same as nothing being overdue/i),
    ).toBeInTheDocument();
  });

  it('renders cards as well as a table, for a phone used standing up', () => {
    const { container } = render(
      <OverdueList
        loans={ROWS}
        page={1}
        hasMore={false}
        counts={COUNTS}
        businessDate="2026-11-03"
      />,
    );

    const list = container.querySelector('ul');
    expect(list?.querySelectorAll('li')).toHaveLength(2);
    expect(list?.className).toContain('md:hidden');
  });

  it('gives the table a caption describing its columns', () => {
    render(
      <OverdueList
        loans={ROWS}
        page={1}
        hasMore={false}
        counts={COUNTS}
        businessDate="2026-11-03"
      />,
    );

    const caption = screen.getByText(/Overdue loans:/i);
    expect(caption.tagName.toLowerCase()).toBe('caption');
  });

  it('never shows a settled loan as overdue', () => {
    // The page excludes them by default, and the component is given none.
    // The *filter* may still offer the state — asking "show me the settled
    // ones" is a legitimate question — so the assertion is about the rows.
    render(
      <OverdueList
        loans={ROWS}
        page={1}
        hasMore={false}
        counts={COUNTS}
        businessDate="2026-11-03"
      />,
    );

    const table = screen.getByRole('table');
    expect(within(table).queryByText('Settled')).toBeNull();

    const cards = screen.getByRole('table').parentElement?.parentElement;
    expect(cards).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The borrower's own view
// ---------------------------------------------------------------------------

describe('the portal loan position', () => {
  it('tells the borrower what to pay now, itemised', () => {
    render(<PortalLoanPosition position={position()} />);

    expect(screen.getByText('Please pay now')).toBeInTheDocument();
    expect(screen.getByText(/UGX\s*8,000/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /UGX\s*4,000 not yet paid from earlier, plus UGX\s*4,000 due today/,
      ),
    ).toBeInTheDocument();
  });

  it('distinguishes what is due now from the whole balance', () => {
    render(<PortalLoanPosition position={position()} />);

    expect(screen.getByText('Still to pay on this loan')).toBeInTheDocument();
    expect(screen.getByText(/UGX\s*120,000/)).toBeInTheDocument();
    // And says plainly that it is not a settlement offer.
    expect(
      screen.getByText(/The whole remaining balance, not a settlement offer/i),
    ).toBeInTheDocument();
  });

  it('explains that missed payments carry forward and add no interest', () => {
    render(<PortalLoanPosition position={position()} />);

    expect(screen.getByText(/1 payment has been missed/)).toBeInTheDocument();
    expect(screen.getByText(/They do not add extra interest/i)).toBeInTheDocument();
  });

  it('counts missed payments in payments, and lateness in days', () => {
    render(
      <PortalLoanPosition
        position={position({
          arrearsAmount: toUgx(12_000),
          currentDue: toUgx(12_000),
          dueToday: toUgx(0),
          missedInstallmentCount: 3,
          daysPastDue: 9,
        })}
      />,
    );

    expect(
      screen.getByText(/3 payments have been missed, the oldest 9 days ago/),
    ).toBeInTheDocument();
  });

  it('shows the completion date and the next payment to clear', () => {
    render(<PortalLoanPosition position={position()} />);

    expect(screen.getByText('Next payment to clear')).toBeInTheDocument();
    expect(screen.getByText('Last payment date on this loan')).toBeInTheDocument();
    expect(screen.getByText('1 Dec 2026')).toBeInTheDocument();
  });

  it('explains the grace period in the borrower"s own terms', () => {
    render(
      <PortalLoanPosition
        position={position({
          pastFinalDueDate: true,
          withinGracePeriod: true,
          state: 'grace_period',
        })}
      />,
    );

    expect(screen.getByText(/Your final payment date has passed/i)).toBeInTheDocument();
    expect(
      screen.getByText(/to pay the balance in full with no extra charge/i),
    ).toBeInTheDocument();
  });

  it('tells the borrower about a charge that is pending, without pretending it exists', () => {
    render(
      <PortalLoanPosition
        position={position({
          pastFinalDueDate: true,
          penaltyEligible: true,
          penaltyProjectedAmount: toUgx(50_000),
          state: 'expired_unpaid',
        })}
      />,
    );

    expect(screen.getByText(/a late-payment charge of/i)).toBeInTheDocument();
    expect(
      screen.getByText(/will be added to your balance when you next pay/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Please speak to our staff/i)).toBeInTheDocument();
  });

  it('calls a penalty a charge, never interest', () => {
    render(
      <PortalLoanPosition
        position={position({
          penaltyApplied: true,
          penaltyAmount: toUgx(50_000),
          penaltyRemaining: toUgx(50_000),
          penaltyAppliedEffectiveDate: toBusinessDate('2026-12-05'),
          contractualOutstanding: toUgx(100_000),
          totalOutstanding: toUgx(150_000),
          state: 'penalty_due',
        })}
      />,
    );

    expect(
      screen.getByText(/It is\s+a charge for settling late, not interest/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Includes a late-payment charge of UGX\s*50,000/),
    ).toBeInTheDocument();
  });

  it('congratulates a borrower who has finished paying', () => {
    render(
      <PortalLoanPosition
        position={position({
          state: 'cleared',
          loanStatus: 'cleared',
          arrearsAmount: toUgx(0),
          dueToday: toUgx(0),
          currentDue: toUgx(0),
          contractualOutstanding: toUgx(0),
          totalOutstanding: toUgx(0),
          missedInstallmentCount: 0,
          daysPastDue: 0,
          oldestPastDueDate: null,
          oldestUnpaidDueDate: null,
        })}
      />,
    );

    expect(screen.getByText(/This loan is fully paid/i)).toBeInTheDocument();
    expect(screen.queryByText('Please pay now')).toBeNull();
  });

  it('shows no staff attribution, internal note or other borrower", nothing operational', () => {
    render(<PortalLoanPosition position={position()} />);

    const text = document.body.textContent ?? '';

    expect(text).not.toMatch(/recorded by|received by|remark|note|officer|treasurer/i);
    // And no judgement about them.
    expect(text).not.toMatch(/default|delinquen|bad/i);
  });

  it('shows no basis, rate or internal penalty mechanics', () => {
    // §109. The borrower needs the charge and what remains of it, not the
    // system's workings.
    render(
      <PortalLoanPosition
        position={position({
          penaltyApplied: true,
          penaltyAmount: toUgx(50_000),
          penaltyRemaining: toUgx(50_000),
          penaltyBasisAmount: toUgx(100_000),
          state: 'penalty_due',
        })}
      />,
    );

    const text = document.body.textContent ?? '';

    expect(text).not.toMatch(/basis|basis points|bps|trigger|grace_period_expired/i);
  });
});

// ---------------------------------------------------------------------------
// The payment screen
// ---------------------------------------------------------------------------

describe('the payment form, with delinquency', () => {
  function obligations(): readonly PaymentObligation[] {
    return [1, 2, 3].map((number) => ({
      obligationId: `inst-${String(number)}`,
      kind: 'installment' as const,
      sequenceNumber: number,
      effectiveDate: toBusinessDate(`2026-11-0${String(number)}`),
      expectedAmount: toUgx(4_000),
      scheduledPrincipal: toUgx(3_000),
      scheduledInterest: toUgx(1_000),
      scheduledPenalty: toUgx(0),
      allocatedAmount: toUgx(0),
      allocatedPrincipal: toUgx(0),
      allocatedInterest: toUgx(0),
      allocatedPenalty: toUgx(0),
    }));
  }

  const BASE = {
    loanId: '11111111-2222-4333-8444-555555555555',
    loanNumber: 'LN260001',
    clientName: 'Amina Nakato',
    clientNumber: 'CL26001',
    obligations: obligations(),
    outstanding: 12_000,
    unpaidDue: 8_000,
    minimumPayment: 4_000,
    idempotencyKey: '99999999-8888-4777-8666-555555555555',
  } as const;

  it('itemises what is due at the counter', () => {
    render(
      <PaymentForm
        {...BASE}
        delinquency={{
          arrears: 4_000,
          dueToday: 4_000,
          currentDue: 8_000,
          contractualOutstanding: 12_000,
          penaltyRemaining: 0,
          penaltyEligible: false,
          penaltyProjectedAmount: 0,
          state: 'in_arrears',
        }}
      />,
    );

    expect(screen.getByText('Due now')).toBeInTheDocument();
    expect(
      screen.getByText(/UGX\s*4,000 previously unpaid plus UGX\s*4,000 due today/),
    ).toBeInTheDocument();
    expect(screen.getByText('Total outstanding')).toBeInTheDocument();
    expect(screen.getByText(/This loan is in arrears\./i)).toBeInTheDocument();
  });

  it('warns that a pending charge will be added before the payment posts', () => {
    render(
      <PaymentForm
        {...BASE}
        delinquency={{
          arrears: 12_000,
          dueToday: 0,
          currentDue: 12_000,
          contractualOutstanding: 12_000,
          penaltyRemaining: 0,
          penaltyEligible: true,
          penaltyProjectedAmount: 6_000,
          state: 'expired_unpaid',
        }}
      />,
    );

    expect(
      screen.getByText('A penalty will be added before this payment'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /the balance on the receipt will be higher than the figure above/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Tell the borrower before taking their money/i),
    ).toBeInTheDocument();
  });

  it('shows a charge that is already in the balance', () => {
    render(
      <PaymentForm
        {...BASE}
        outstanding={18_000}
        delinquency={{
          arrears: 12_000,
          dueToday: 0,
          currentDue: 12_000,
          contractualOutstanding: 12_000,
          penaltyRemaining: 6_000,
          penaltyEligible: false,
          penaltyProjectedAmount: 0,
          state: 'penalty_due',
        }}
      />,
    );

    expect(screen.getByText(/Includes UGX\s*6,000 penalty/)).toBeInTheDocument();
  });

  it('falls back to Phase 6"s single figure when delinquency is not readable', () => {
    render(<PaymentForm {...BASE} />);

    expect(screen.getByText('Due now')).toBeInTheDocument();
    expect(screen.getByText(/UGX\s*8,000/)).toBeInTheDocument();
    // No itemisation claimed, and no penalty asserted either way.
    expect(document.body.textContent ?? '').not.toMatch(/previously unpaid/i);
    expect(document.body.textContent ?? '').not.toMatch(/penalty/i);
  });

  it('shows a penalty column on the confirmation, so the split is visible', async () => {
    const user = userEvent.setup();

    render(
      <PaymentForm
        {...BASE}
        delinquency={{
          arrears: 8_000,
          dueToday: 0,
          currentDue: 8_000,
          contractualOutstanding: 12_000,
          penaltyRemaining: 0,
          penaltyEligible: false,
          penaltyProjectedAmount: 0,
          state: 'in_arrears',
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Continue/i }));

    const table = screen.getByRole('table');

    expect(within(table).getByText('Principal')).toBeInTheDocument();
    expect(within(table).getByText('Interest')).toBeInTheDocument();
    expect(within(table).getByText('Penalty')).toBeInTheDocument();
  });
});
