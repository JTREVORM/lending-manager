import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { RowActions } from '@/components/ui/row-actions';
import { StageText, StatusText } from '@/components/ui/status-text';
import { loanRowActions } from '@/components/loans/loan-row-actions';
import {
  formatCount,
  formatDays,
  formatDaysLate,
  formatMonths,
} from '@/lib/domain/duration';
import { describePage, pageCount, toPageSize } from '@/lib/domain/pagination';

/**
 * The register redesign: words written out, status as text, real actions,
 * and a pagination line that only claims what it knows.
 */

describe('values are written the way a person says them', () => {
  it('never abbreviates a loan term', () => {
    expect(formatMonths(1)).toBe('1 month');
    expect(formatMonths(2)).toBe('2 months');
    expect(formatMonths(12)).toBe('12 months');
  });

  it('gets singular and plural right for days', () => {
    expect(formatDays(1)).toBe('1 day');
    expect(formatDays(45)).toBe('45 days');
  });

  it('says "Not late" rather than "0 days late"', () => {
    // Zero is a real answer, and "0 days late" reads for a moment as late.
    expect(formatDaysLate(0)).toBe('Not late');
    expect(formatDaysLate(1)).toBe('1 day late');
  });

  it('takes an irregular plural rather than guessing one', () => {
    expect(formatCount(1, 'entry', 'entries')).toBe('1 entry');
    expect(formatCount(4, 'entry', 'entries')).toBe('4 entries');
  });

  it('leaves no abbreviated month in the source', () => {
    // The defect the brief named: `1 mo` in a register. It is gone, and
    // this keeps it gone — a template writing ` mo` after a number is the
    // shape it came back as last time.
    const offenders = globSync('{app,components}/**/*.tsx')
      .map((path) => path.replaceAll('\\', '/'))
      .filter((path) => /\} mo\b|' mo'|" mo"|\} mos\b/.test(readFileSync(path, 'utf8')));

    expect(offenders).toEqual([]);
  });
});

describe('a status is text, not a button', () => {
  it('states the status in words, with colour as a second channel only', () => {
    render(<StatusText tone="critical">Arrears</StatusText>);

    const status = screen.getByText('Arrears');
    // The word carries it; a colour-blind reader, a printout and a screen
    // reader all get the same answer.
    expect(status.textContent).toBe('Arrears');
    expect(status.getAttribute('data-status-tone')).toBe('critical');
    // Not a pill: no fill, no ring, no uppercase.
    expect(status.className).not.toContain('rounded-full');
    expect(status.className).not.toContain('uppercase');
  });

  it('keeps a status on one line', () => {
    render(<StatusText tone="attention">Awaiting disbursement</StatusText>);
    expect(screen.getByText('Awaiting disbursement').className).toContain(
      'whitespace-nowrap',
    );
  });

  it('leaves the stage quiet, so it does not paint the status twice', () => {
    render(<StageText>Active</StageText>);
    expect(screen.getByText('Active').className).toContain('text-text-muted');
  });
});

describe('the row action menu', () => {
  const ACTIONS = [
    { label: 'View loan details', href: '/loans/abc' },
    {
      label: 'Record payment',
      href: '/payments/new?loanId=abc',
      emphasis: 'strong' as const,
    },
  ];

  it('names the record it acts on', () => {
    render(<RowActions actions={ACTIONS} label="loan LN260034" />);
    // Twenty buttons called "Actions" are twenty identical buttons.
    expect(
      screen.getByRole('button', { name: 'Actions for loan LN260034' }),
    ).toBeTruthy();
  });

  it('opens on a click and offers its entries as links', async () => {
    const user = userEvent.setup();
    render(<RowActions actions={ACTIONS} label="loan LN260034" />);

    await user.click(screen.getByRole('button', { name: /Actions for/ }));

    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(2);
    // Links, so middle-click and open-in-new-tab work, and a screen reader
    // knows pressing one will not spend money.
    expect(items[0]?.tagName.toLowerCase()).toBe('a');
    expect(items[0]?.getAttribute('href')).toBe('/loans/abc');
  });

  it('closes on Escape and gives focus back to the trigger', async () => {
    const user = userEvent.setup();
    render(<RowActions actions={ACTIONS} label="loan LN260034" />);

    const trigger = screen.getByRole('button', { name: /Actions for/ });
    await user.click(trigger);
    expect(screen.queryByRole('menu')).toBeTruthy();

    await user.keyboard('{Escape}');

    // A menu that closes and drops focus to the body leaves a keyboard user
    // at the top of the document.
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('renders nothing to press when there is nothing this person may do', () => {
    render(<RowActions actions={[]} label="loan LN260034" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('what a loan offers, and what it never offers', () => {
  const all = () => true;
  const none = () => false;

  it('never offers to delete a loan', () => {
    // A loan is a financial record. It is cancelled or rejected, with a
    // reason and an audit entry, and it is never removed.
    for (const status of [
      'draft',
      'pending_approval',
      'approved',
      'active',
      'cleared',
      'cancelled',
    ] as const) {
      const labels = loanRowActions({ loanId: 'x', status, can: all }).map(
        (a) => a.label,
      );
      expect(labels.join(' ')).not.toMatch(/delete|remove/i);
    }
  });

  it('offers a decision only where the workflow has one waiting', () => {
    const draft = loanRowActions({ loanId: 'x', status: 'draft', can: all });
    expect(draft.map((a) => a.label)).toContain('Submit for approval');
    expect(draft.map((a) => a.label)).not.toContain('Disburse loan');

    const pending = loanRowActions({ loanId: 'x', status: 'pending_approval', can: all });
    expect(pending.map((a) => a.label)).toContain('Approve or reject');

    const active = loanRowActions({ loanId: 'x', status: 'active', can: all });
    expect(active.map((a) => a.label)).toContain('Record payment');
    expect(active.map((a) => a.label)).not.toContain('Edit draft');
  });

  it('sends a decision to the loan page, never to a one-click endpoint', () => {
    const pending = loanRowActions({
      loanId: 'abc',
      status: 'pending_approval',
      can: all,
    });
    const approve = pending.find((a) => a.label === 'Approve or reject');

    // The lifecycle panel there has the confirmation, the reason field, the
    // server-side validation and the audit entry. A menu item that approved
    // a loan from a list would be a way around all four.
    expect(approve?.href).toBe('/loans/abc');
  });

  it('drops every entry the signed-in person may not act on', () => {
    const labels = loanRowActions({ loanId: 'x', status: 'draft', can: none }).map(
      (a) => a.label,
    );

    expect(labels).toEqual(['View loan details', 'View application']);
  });

  it('offers no statement for a loan that has moved no money', () => {
    const draft = loanRowActions({ loanId: 'x', status: 'draft', can: all });
    expect(draft.map((a) => a.label)).not.toContain('View statement');

    const active = loanRowActions({ loanId: 'x', status: 'active', can: all });
    expect(active.map((a) => a.label)).toContain('View statement');
  });
});

describe('the pagination line claims only what it was given', () => {
  it('states the range and the total where there is one', () => {
    expect(
      describePage({ page: 1, pageSize: 20, rows: 20, total: 35, noun: 'loan' }),
    ).toBe('Showing 1–20 of 35 loans');
  });

  it('counts the last page by the rows it actually returned', () => {
    // `21–40 of 35` is both wrong and the kind of wrong that makes a reader
    // distrust the figures beside it.
    expect(
      describePage({ page: 2, pageSize: 20, rows: 15, total: 35, noun: 'loan' }),
    ).toBe('Showing 21–35 of 35 loans');
  });

  it('says nothing about a total it was not given', () => {
    expect(describePage({ page: 1, pageSize: 20, rows: 20, noun: 'loan' })).toBe(
      'Showing 1–20 loans',
    );
  });

  it('refuses a page size that was not offered', () => {
    // It becomes a `range`, and an arbitrary one is an invitation to ask a
    // free-tier database for fifty thousand rows from an edited URL.
    expect(toPageSize(50)).toBe(50);
    expect(toPageSize(50_000)).toBe(20);
    expect(toPageSize('nonsense')).toBe(20);
  });

  it('counts an empty register as one page, not zero', () => {
    expect(pageCount(0, 20)).toBe(1);
    expect(pageCount(35, 20)).toBe(2);
  });
});
