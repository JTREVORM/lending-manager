import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AwaitingDecision } from '@/components/dashboard/awaiting-decision';
import { RecoveryWorkloadCards } from '@/components/dashboard/recovery-workload';
import { RiskHeadline } from '@/components/dashboard/risk-headline';
import type { PendingApprovals, RecoveryWorkload } from '@/lib/data/dashboard';
import type { ParSlice } from '@/lib/data/security';
import { toUgx } from '@/lib/domain/money';
import { getByCompositeText } from '../helpers/text';

/**
 * What the dashboard says about the modules built after it.
 *
 * The dashboard was written when the system ended at payments. Risk
 * monitoring, the recovery file and the money movements that wait for a
 * decision all arrived later, and each was reachable only by opening the
 * screen it lives on — so the page a person opens first said nothing about
 * any of them.
 *
 * These three sections fix that, and the ways a summary card goes wrong are
 * the same ones the Phase 8 cards were written against: a ratio with no
 * denominator, a zero that means "nothing recorded" rendered as a real
 * figure, a count somebody cannot act on, and a blank panel indistinguishable
 * from a failed query.
 */

const EMPTY_BUCKETS = {
  current: 0,
  '1_7': 0,
  '8_30': 0,
  '31_60': 0,
  '61_90': 0,
  '90_plus': 0,
} as const;

const EMPTY_PRINCIPAL = {
  current: toUgx(0),
  '1_7': toUgx(0),
  '8_30': toUgx(0),
  '31_60': toUgx(0),
  '61_90': toUgx(0),
  '90_plus': toUgx(0),
} as const;

function slice(overrides: Partial<ParSlice> = {}): ParSlice {
  return {
    scope: 'portfolio',
    branchId: null,
    branchName: null,
    productId: null,
    productCode: null,
    productName: null,
    loanCount: 17,
    principalOutstanding: toUgx(24_500_000),
    totalOutstanding: toUgx(28_900_000),
    arrearsAmount: toUgx(1_850_000),
    loansAtRisk: { 1: 9, 7: 7, 30: 4, 60: 2, 90: 1 },
    principalAtRisk: {
      1: toUgx(11_000_000),
      7: toUgx(8_400_000),
      30: toUgx(4_900_000),
      60: toUgx(2_100_000),
      90: toUgx(900_000),
    },
    parBps: { 1: 4490, 7: 3429, 30: 2000, 60: 857, 90: 367 },
    loansByBucket: { ...EMPTY_BUCKETS, current: 8, '8_30': 5, '31_60': 3, '90_plus': 1 },
    principalByBucket: {
      ...EMPTY_PRINCIPAL,
      current: toUgx(13_500_000),
      '8_30': toUgx(6_200_000),
      '31_60': toUgx(3_900_000),
      '90_plus': toUgx(900_000),
    },
    ...overrides,
  };
}

// ===========================================================================
describe('portfolio at risk on the dashboard', () => {
  it('shows one ratio, with the principal it divides', () => {
    render(<RiskHeadline slice={slice()} />);

    // PAR 30 at 2000bps is 20.0%, and the principal behind it is on the card.
    // A percentage on its own invites comparison with a figure computed some
    // other way; the denominator is what makes it checkable.
    expect(screen.getByText('20.0%')).toBeInTheDocument();
    // `<Money>` renders the code and the figure as separate nodes on purpose
    // — a span can be told not to break and a string cannot — so the
    // assertion reads the sentence rather than one node of it.
    expect(getByCompositeText(/UGX 4,900,000 of principal/)).toBeInTheDocument();
  });

  it('says what the ratio divides by, in words, on the card', () => {
    render(<RiskHeadline slice={slice()} />);

    // The two substitutions that quietly break PAR are using total
    // outstanding, which includes interest not yet earned, and using the
    // arrears figure, which is a fraction of the exposure. The definition
    // rules both out where a reader can see it.
    const definition = screen.getByText(/Outstanding principal on loans at least/);

    expect(definition).toBeInTheDocument();
    expect(definition.textContent).toMatch(/not total outstanding/i);
    expect(definition.textContent).toMatch(/not the arrears figure/i);
  });

  it('shows a dash rather than zero for a book with no loans', () => {
    render(
      <RiskHeadline
        slice={slice({
          loanCount: 0,
          principalOutstanding: toUgx(0),
          parBps: { 1: null, 7: null, 30: null, 60: null, 90: null },
          loansByBucket: EMPTY_BUCKETS,
          principalByBucket: EMPTY_PRINCIPAL,
        })}
      />,
    );

    // A business with no active loans is not a business in perfect health,
    // and a tile reading 0.0% says the second thing.
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
  });

  it('offers the other four ratios rather than crowding them in', () => {
    render(<RiskHeadline slice={slice()} />);

    const link = screen.getByRole('link', { name: /Aging and all five ratios/ });
    expect(link).toHaveAttribute('href', '/reports/aging');
  });

  it('links the worst bucket straight to its own slice of the report', () => {
    render(<RiskHeadline slice={slice()} />);

    expect(
      screen
        .getAllByRole('link')
        .some((link) => (link.getAttribute('href') ?? '').includes('bucket=90_plus')),
    ).toBe(true);
  });

  it('says nothing has gone that far rather than showing an empty amount', () => {
    render(
      <RiskHeadline
        slice={slice({ loansByBucket: { ...EMPTY_BUCKETS, current: 17 } })}
      />,
    );

    expect(screen.getByText(/Nothing has gone this far/)).toBeInTheDocument();
  });
});

// ===========================================================================
describe('promises and follow-ups on the dashboard', () => {
  function workload(overrides: Partial<RecoveryWorkload> = {}): RecoveryWorkload {
    return {
      promisesDueToday: 2,
      promisesBroken: 3,
      promisedBrokenAmount: toUgx(410_000),
      followUpsOverdue: 5,
      loansInRecovery: 9,
      ...overrides,
    };
  }

  it('counts the three kinds of work separately', () => {
    render(<RecoveryWorkloadCards workload={workload()} />);

    expect(screen.getByText('Promises due today')).toBeInTheDocument();
    expect(screen.getByText('Promises broken')).toBeInTheDocument();
    expect(screen.getByText('Follow-ups overdue')).toBeInTheDocument();
  });

  it('says a promise due later is not counted today', () => {
    render(<RecoveryWorkloadCards workload={workload()} />);

    // A card that counted the week's promises would make every day look like
    // the busiest one.
    expect(
      screen.getByText(/A promise for a later date is not counted here/),
    ).toBeInTheDocument();
  });

  it('says the verdict is derived rather than stored', () => {
    render(<RecoveryWorkloadCards workload={workload()} />);

    // Both cards say it, in their own words, because both figures depend on
    // it: nothing marks a promise kept or broken, so nothing has to come back
    // and correct the number a dashboard is showing.
    expect(
      screen.getAllByText(
        /derived from the posted payments|read from the posted payments/i,
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('does not claim that paying late un-breaks a promise', () => {
    render(<RecoveryWorkloadCards workload={workload()} />);

    // The first version of this card said a later payment "reverses the
    // verdict". It does not: Phase 14's view counts only the payments
    // received between the action date and the promised date, so a borrower
    // who said Monday and paid Thursday settled the loan and still broke the
    // promise. `tests/db/dashboard-attention.test.ts` is what caught it, and
    // this is what stops the wording drifting back.
    const broken = screen.getByText(/A promise whose date passed/);

    expect(broken.textContent).toMatch(/does not un-break/i);
    expect(screen.queryByText(/reverses the verdict/i)).not.toBeInTheDocument();
  });

  it('carries the amount behind the broken promises', () => {
    render(<RecoveryWorkloadCards workload={workload()} />);

    expect(getByCompositeText(/UGX 410,000 undertaken/)).toBeInTheDocument();
  });

  it('states plainly when nothing has been broken', () => {
    render(
      <RecoveryWorkloadCards
        workload={workload({ promisesBroken: 0, promisedBrokenAmount: toUgx(0) })}
      />,
    );

    // Not `UGX 0` undertaken, which reads as a promise of nothing.
    expect(screen.getByText(/Nothing has gone past its date unpaid/)).toBeInTheDocument();
  });

  it('sends the officer to the screen that can record an action', () => {
    render(<RecoveryWorkloadCards workload={workload()} />);

    expect(screen.getByRole('link', { name: /Open Debt & Security/ })).toHaveAttribute(
      'href',
      '/recovery',
    );
  });
});

// ===========================================================================
describe('money movements awaiting a decision', () => {
  function pending(overrides: Partial<PendingApprovals> = {}): PendingApprovals {
    return { transfers: 2, expenses: 1, reconciliations: 0, ...overrides };
  }

  it('shows only the kinds that actually have something waiting', () => {
    render(<AwaitingDecision pending={pending()} />);

    expect(screen.getByText('Transfers awaiting approval')).toBeInTheDocument();
    expect(screen.getByText('Expenses awaiting approval')).toBeInTheDocument();
    // A zero tile is a tile that invites a click that goes nowhere.
    expect(screen.queryByText('Counts awaiting review')).not.toBeInTheDocument();
  });

  it('says nothing is waiting rather than showing three zeroes', () => {
    render(
      <AwaitingDecision
        pending={pending({ transfers: 0, expenses: 0, reconciliations: 0 })}
      />,
    );

    // A row of empty tiles reads as a section that failed to load.
    expect(screen.getByText(/Nothing is waiting/)).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('links each count to the screen the decision is made on', () => {
    render(<AwaitingDecision pending={pending({ reconciliations: 4 })} />);

    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));

    expect(hrefs).toContain('/finance/transfers');
    expect(hrefs).toContain('/finance/expenses');
    expect(hrefs).toContain('/finance/reconciliation');
  });

  it('says a transfer is not income or expense, where somebody is deciding', () => {
    render(<AwaitingDecision pending={pending()} />);

    // The accounting rule, at the moment it matters most: the person about to
    // approve a movement between the business's own accounts.
    expect(screen.getByText(/A transfer is not income or expense/)).toBeInTheDocument();
  });

  it('counts a submitted cash count as waiting, because it is', () => {
    render(
      <AwaitingDecision
        pending={pending({ transfers: 0, expenses: 0, reconciliations: 3 })}
      />,
    );

    // A reconciliation waits in the `submitted` state rather than a
    // `pending_approval` one — it has been counted and is waiting to be
    // reviewed, which is the same kind of queue and belongs in the same
    // place. The count is the only one on the section, so finding it is
    // enough to know it belongs to this tile.
    expect(screen.getByText('Counts awaiting review')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.queryByText('Transfers awaiting approval')).not.toBeInTheDocument();
  });
});
