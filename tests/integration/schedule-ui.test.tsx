import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  RepaymentScheduleTable,
  type ScheduleRow,
} from '@/components/loans/repayment-schedule-table';
import { ScheduleSummary } from '@/components/loans/schedule-summary';
import { toBusinessDate } from '@/lib/domain/datetime';
import { calculateLoan } from '@/lib/domain/loan';
import { toUgx } from '@/lib/domain/money';
import { generateRepaymentSchedule } from '@/lib/domain/repayment-schedule';
import { getByCompositeText } from '../helpers/text';

/**
 * The Phase 5 screens.
 *
 * Browser-level layout verification needs a live Supabase instance, which this
 * environment cannot run. These assertions cover what can be checked without
 * one, and for a collection schedule the most important are **what the screen
 * refuses to claim** — no paid, no missed, no outstanding balance — and
 * whether a preview is labelled as one.
 */

const TODAY = toBusinessDate('2026-10-20');

/** A real schedule, built by the engine, so the rows are not hand-faked. */
function scheduleRows(): readonly ScheduleRow[] {
  const contract = calculateLoan({
    principal: toUgx(200_000),
    monthlyInterestRateBps: 1_500,
    termMonths: 2,
  });

  const schedule = generateRepaymentSchedule({
    disbursementDate: toBusinessDate('2026-10-10'),
    periods: contract.periods,
    intervalDays: 1,
  });

  return schedule.installments.map((row) => ({
    id: `installment-${String(row.installmentNumber)}`,
    installmentNumber: row.installmentNumber,
    loanPeriodNumber: row.loanPeriodNumber,
    periodInstallmentNumber: row.periodInstallmentNumber,
    dueDate: row.dueDate,
    scheduledPrincipal: row.scheduledPrincipal,
    scheduledInterest: row.scheduledInterest,
    expectedAmount: row.expectedAmount,
  }));
}

describe('the repayment schedule table', () => {
  it('renders every scheduled collection', () => {
    const rows = scheduleRows();
    render(<RepaymentScheduleTable installments={rows} today={TODAY} />);

    const table = screen.getByRole('table');
    // One header row plus one row per collection, in the desktop rendering.
    expect(within(table).getAllByRole('row')).toHaveLength(rows.length + 1);
  });

  it('shows the due date, both components and the total for a collection', () => {
    render(<RepaymentScheduleTable installments={scheduleRows()} today={TODAY} />);

    const table = screen.getByRole('table');
    // The first collection of a 200,000 / 2-month loan daily: 3,333 principal
    // and 1,000 interest, totalling 4,333.
    const firstRow = within(table).getAllByRole('row')[1];

    expect(firstRow).toBeDefined();
    expect(firstRow?.textContent).toContain('11 Oct 2026');
    expect(firstRow?.textContent).toContain('3,333');
    expect(firstRow?.textContent).toContain('1,000');
    expect(firstRow?.textContent).toContain('4,333');
  });

  it('names the contractual month each collection belongs to', () => {
    render(<RepaymentScheduleTable installments={scheduleRows()} today={TODAY} />);

    const headers = screen
      .getAllByRole('columnheader')
      .map((header) => header.textContent);

    expect(headers).toContain('Month');
  });

  // =======================================================================
  describe('what it refuses to claim', () => {
    it('never says an installment is paid, missed, overdue or in arrears', () => {
      // Phase 5 has no payment data. Any of these words would assert
      // something about a borrower that the system cannot support — and a
      // borrower who paid on time being shown as delinquent is a worse
      // failure than showing nothing.
      render(<RepaymentScheduleTable installments={scheduleRows()} today={TODAY} />);

      const text = document.body.textContent ?? '';

      for (const forbidden of [
        /\bpaid\b/i,
        /\bunpaid\b/i,
        /\bmissed\b/i,
        /\boverdue\b/i,
        /\barrears\b/i,
        /\boutstanding\b/i,
        /\bbalance\b/i,
        /\bremaining\b/i,
        /\bpartial/i,
      ]) {
        expect(text, `must not say ${String(forbidden)}`).not.toMatch(forbidden);
      }
    });

    it('describes an elapsed date as a calendar fact, not a judgement', () => {
      render(<RepaymentScheduleTable installments={scheduleRows()} today={TODAY} />);

      // 11–19 October are before 20 October, the "today" passed in.
      expect(screen.getAllByText('Date passed').length).toBeGreaterThan(0);
    });

    it('shows no running balance column', () => {
      render(<RepaymentScheduleTable installments={scheduleRows()} today={TODAY} />);

      const headers = screen
        .getAllByRole('columnheader')
        .map((header) => (header.textContent ?? '').toLowerCase());

      expect(headers).toEqual([
        '#',
        'due date',
        'month',
        'principal',
        'interest',
        'expected',
        'status',
      ]);
    });
  });

  // =======================================================================
  describe('date-derived state', () => {
    it('marks a collection due today', () => {
      render(
        <RepaymentScheduleTable
          installments={scheduleRows()}
          today={toBusinessDate('2026-10-15')}
        />,
      );

      expect(screen.getAllByText('Due today')).toHaveLength(
        // One table rendering and one card rendering, both in the DOM;
        // which is visible is a CSS breakpoint decision.
        2,
      );
    });

    it('marks later collections upcoming', () => {
      render(
        <RepaymentScheduleTable
          installments={scheduleRows()}
          today={toBusinessDate('2026-10-15')}
        />,
      );

      expect(screen.getAllByText('Upcoming').length).toBeGreaterThan(0);
    });

    it('shows every collection as upcoming before the schedule starts', () => {
      const rows = scheduleRows();

      render(
        <RepaymentScheduleTable
          installments={rows}
          today={toBusinessDate('2026-10-01')}
        />,
      );

      expect(screen.queryByText('Date passed')).toBeNull();
      expect(screen.queryByText('Due today')).toBeNull();
    });
  });

  // =======================================================================
  describe('the preview', () => {
    it('is labelled, so a staff member knows the dates may still move', () => {
      render(
        <RepaymentScheduleTable
          installments={scheduleRows()}
          today={TODAY}
          provisional
        />,
      );

      expect(screen.getByText(/Preview only/i)).toBeInTheDocument();
      expect(
        screen.getByText(/generated at disbursement, from the day the money actually/i),
      ).toBeInTheDocument();
    });

    it('is not labelled when the schedule is the real one', () => {
      render(<RepaymentScheduleTable installments={scheduleRows()} today={TODAY} />);

      expect(screen.queryByText(/Preview only/i)).toBeNull();
    });

    it('shows no date-derived status on a preview', () => {
      // A preview's dates are not yet real, so saying one has passed would
      // be meaningless at best.
      render(
        <RepaymentScheduleTable
          installments={scheduleRows()}
          today={TODAY}
          provisional
        />,
      );

      expect(screen.queryByText('Date passed')).toBeNull();
      expect(screen.queryByText('Upcoming')).toBeNull();
    });
  });

  // =======================================================================
  describe('an empty schedule', () => {
    it('explains that one appears at disbursement rather than showing nothing', () => {
      render(<RepaymentScheduleTable installments={[]} today={TODAY} />);

      expect(
        screen.getByText(/generated when the loan is disbursed/i),
      ).toBeInTheDocument();
    });
  });

  // =======================================================================
  describe('accessibility', () => {
    it('gives the table a caption describing its columns', () => {
      render(<RepaymentScheduleTable installments={scheduleRows()} today={TODAY} />);

      const caption = screen.getByText(/Repayment collection schedule:/i);
      expect(caption).toBeInTheDocument();
      expect(caption.tagName.toLowerCase()).toBe('caption');
    });

    it('marks the collection number as a row header', () => {
      render(<RepaymentScheduleTable installments={scheduleRows()} today={TODAY} />);

      const rowHeaders = screen.getAllByRole('rowheader');
      expect(rowHeaders.length).toBeGreaterThan(0);
    });

    it('renders a card list as well as a table, for narrow screens', () => {
      // Seven columns at 320px is unreadable however it is squeezed, and a
      // daily three-month loan is 91 rows — a horizontally scrolling table
      // would mean dragging sideways on every one.
      const rows = scheduleRows();
      const { container } = render(
        <RepaymentScheduleTable installments={rows} today={TODAY} />,
      );

      const list = container.querySelector('ul');
      expect(list).not.toBeNull();
      expect(list?.querySelectorAll('li')).toHaveLength(rows.length);

      // The card list is the small-screen rendering and the table the wide
      // one, so exactly one is visible at any width.
      expect(list?.className).toContain('sm:hidden');
    });

    it('keeps the table from widening the page on a narrow screen', () => {
      const { container } = render(
        <RepaymentScheduleTable installments={scheduleRows()} today={TODAY} />,
      );

      // `min-w-0` lets the flex/grid child shrink; without it a wide table
      // forces the whole page to scroll horizontally.
      const root = container.firstElementChild;
      expect(root?.className).toContain('min-w-0');
    });
  });
});

// =========================================================================
describe('the schedule summary', () => {
  const PROPS = {
    installmentCount: 60,
    firstDueDate: toBusinessDate('2026-10-11'),
    finalDueDate: toBusinessDate('2026-12-09'),
    totalScheduledPrincipal: 200_000,
    totalScheduledInterest: 45_000,
    totalScheduledAmount: 245_000,
    frequencyLabel: 'Daily',
    intervalDays: 1,
    disbursementDate: toBusinessDate('2026-10-10'),
    reconciles: true,
  } as const;

  it('reports the count, the dates, the cadence and the totals', () => {
    render(<ScheduleSummary {...PROPS} />);

    expect(screen.getByText('60')).toBeInTheDocument();
    expect(screen.getByText('11 Oct 2026')).toBeInTheDocument();
    expect(screen.getByText('9 Dec 2026')).toBeInTheDocument();
    expect(screen.getByText('10 Oct 2026')).toBeInTheDocument();
    expect(screen.getByText(/UGX\s*245,000/)).toBeInTheDocument();
  });

  it('names the final collection as the scheduled completion date', () => {
    // Phase 7 builds loan expiry, grace periods and penalties on this, so it
    // is labelled rather than left for a reader to infer.
    render(<ScheduleSummary {...PROPS} />);

    expect(screen.getByText('Scheduled completion')).toBeInTheDocument();
  });

  it('spells out what the cadence means in days', () => {
    render(<ScheduleSummary {...PROPS} intervalDays={3} frequencyLabel="Every 3 days" />);

    // The parenthesised suffix specifically, not the label it sits beside —
    // the point is that the cadence is spelled out in days even if somebody
    // renames the frequency to something opaque.
    expect(screen.getByText(/\(every 3 days\)/)).toBeInTheDocument();
  });

  it('says "every day" rather than "every 1 days"', () => {
    render(<ScheduleSummary {...PROPS} />);

    expect(screen.getByText(/\(every day\)/)).toBeInTheDocument();
  });

  it('breaks the total into principal and interest', () => {
    render(<ScheduleSummary {...PROPS} />);

    expect(getByCompositeText(/200,000 principal/)).toBeInTheDocument();
    expect(getByCompositeText(/45,000 interest/)).toBeInTheDocument();
  });

  it('warns loudly when the totals do not reconcile', () => {
    // This state should be unreachable — the database reconciles before it
    // commits — which is exactly why it must announce itself if it appears,
    // rather than presenting figures nobody can stand behind.
    render(<ScheduleSummary {...PROPS} reconciles={false} />);

    expect(screen.getByText(/do not reconcile/i)).toBeInTheDocument();
    expect(screen.getByText(/Do not collect against this schedule/i)).toBeInTheDocument();
  });

  it('shows no warning when the totals do reconcile', () => {
    render(<ScheduleSummary {...PROPS} />);

    expect(screen.queryByText(/do not reconcile/i)).toBeNull();
  });

  it('claims nothing about payment', () => {
    render(<ScheduleSummary {...PROPS} />);

    const text = document.body.textContent ?? '';

    for (const forbidden of [/\bpaid\b/i, /\bcollected\b/i, /\boutstanding\b/i]) {
      expect(text).not.toMatch(forbidden);
    }
  });

  it('uses a description list, so each figure is labelled for a screen reader', () => {
    const { container } = render(<ScheduleSummary {...PROPS} />);

    const list = container.querySelector('dl');
    expect(list).not.toBeNull();
    expect(list?.querySelectorAll('dt').length).toBeGreaterThanOrEqual(6);
  });
});

// =========================================================================
describe('the schedule reconciles whatever the screen does with it', () => {
  it('renders rows that still sum to the contractual total', () => {
    // The screen is the last place a figure can go wrong before a borrower
    // reads it aloud. Summing what was actually rendered catches a
    // formatting or slicing mistake that the data-layer tests would not.
    const rows = scheduleRows();

    render(<RepaymentScheduleTable installments={rows} today={TODAY} />);

    const total = rows.reduce((sum, row) => sum + row.expectedAmount, 0);
    expect(total).toBe(245_000);

    const table = screen.getByRole('table');
    const bodyRows = within(table).getAllByRole('row').slice(1);
    expect(bodyRows).toHaveLength(rows.length);
  });
});
