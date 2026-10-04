import { render, screen } from '@testing-library/react';
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DateValue, PhoneValue } from '@/components/ui/data-value';
import { Money, MoneyStat } from '@/components/ui/money';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/ui/states';
import { toUgx } from '@/lib/domain/money';
import { toBusinessDate } from '@/lib/domain/datetime';

/**
 * The display primitives Phase 9 introduced, and the invariants that justify
 * them existing at all.
 *
 * Every one of these tests traces to a specific defect in the pre-Phase-9
 * screenshot review. They are written against the rendered DOM rather than
 * the source, because the failures were visual: a currency code on its own
 * line, a phone number in two formats, a date in US order.
 */

describe('Money', () => {
  it('renders the code and the figure as one unbreakable value', () => {
    // The payments register broke "UGX" onto its own line on every single
    // row. The fix is structural and must stay structural: a nowrap box, not
    // a non-breaking space that a later refactor can normalise away.
    render(<Money amount={toUgx(148_705)} />);

    const value = screen.getByText('UGX 148,705');
    expect(value.className).toContain('whitespace-nowrap');
    expect(value.className).toContain('inline-block');
  });

  it('uses tabular figures, so a column of amounts lines up', () => {
    render(<Money amount={toUgx(1_250_000)} />);

    expect(screen.getByText('UGX 1,250,000').className).toContain('tabular');
  });

  it('drops the currency code when the column already says it', () => {
    render(<Money amount={toUgx(17_844)} variant="bare" />);

    expect(screen.getByText('17,844')).toBeInTheDocument();
    expect(screen.queryByText(/UGX/)).toBeNull();
  });

  it('distinguishes "nothing recorded" from "zero shillings"', () => {
    // A pending loan has no amounts yet; a cleared loan owes zero. Rendering
    // both as UGX 0 would state something the record does not say.
    const { unmount } = render(<Money amount={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText(/UGX/)).toBeNull();
    unmount();

    render(<Money amount={toUgx(0)} />);
    expect(screen.getByText('UGX 0')).toBeInTheDocument();
  });

  it('marks a reversed amount in words as well as with a line', () => {
    // A line through a number is invisible to a screen reader and easy to
    // miss in a glance down a column.
    render(<Money amount={toUgx(29_741)} struck />);

    const value = screen.getByText('UGX 29,741');
    expect(value.className).toContain('line-through');
    expect(value.getAttribute('title')).toMatch(/reversed/i);
  });

  it('marks every rendered sum, so a layout test can find them all', () => {
    render(
      <div>
        <Money amount={toUgx(1)} />
        <Money amount={toUgx(2)} variant="bare" />
      </div>,
    );

    expect(document.querySelectorAll('[data-money]')).toHaveLength(2);
  });

  it('is covered by the financial arithmetic audit', () => {
    // Every sum in the application now passes through this component, which
    // makes it the one place a stray `toFixed` would misstate every figure at
    // once. `npm run audit:money` is what actually scans it; this asserts the
    // file is in the audit's list, so the coverage cannot be dropped silently.
    const audit = readFileSync(
      join(process.cwd(), 'scripts/audit-financial-arithmetic.mjs'),
      'utf8',
    );

    expect(audit).toContain("'components/ui/money.tsx'");
  });

  it('reaches no arithmetic of its own', () => {
    // The display path formats what an engine decided. It never adds, scales
    // or rounds — a component that computes is a second source of truth.
    const source = readFileSync(join(process.cwd(), 'components/ui/money.tsx'), 'utf8');

    for (const forbidden of ['toFixed(', 'Math.', 'parseFloat', 'reduce(']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('pairs a figure with its label', () => {
    render(<MoneyStat label="Still due today" amount={toUgx(72_866)} note="3 of 5" />);

    expect(screen.getByText('Still due today')).toBeInTheDocument();
    expect(screen.getByText('UGX 72,866')).toBeInTheDocument();
    expect(screen.getByText('3 of 5')).toBeInTheDocument();
  });
});

describe('PhoneValue', () => {
  it('renders one format, the international one', () => {
    // The review found `077 211 0015` on the client list and `+256772110015`
    // on the overdue page for the same borrower.
    render(<PhoneValue value="+256772110015" />);

    expect(screen.getByText('+256 772 110 015')).toBeInTheDocument();
  });

  it('keeps the number on one line', () => {
    render(<PhoneValue value="+256772110015" />);

    expect(screen.getByText('+256 772 110 015').className).toContain('whitespace-nowrap');
  });

  it('dials when asked to, with the canonical value in the href', () => {
    // The display form is grouped for reading; the href has to be what the
    // dialler can use.
    render(<PhoneValue value="+256772110015" linked />);

    const link = screen.getByRole('link', { name: '+256 772 110 015' });
    expect(link.getAttribute('href')).toBe('tel:+256772110015');
  });

  it('prints an unrecognised number as it stands rather than mangling it', () => {
    render(<PhoneValue value="not-a-number" />);

    expect(screen.getByText('not-a-number')).toBeInTheDocument();
  });

  it('shows a dash for a number that was never recorded', () => {
    render(<PhoneValue value={null} />);

    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('DateValue', () => {
  it('writes a date the one way this application writes dates', () => {
    render(<DateValue value={toBusinessDate('2026-10-04')} />);

    expect(screen.getByText('4 Oct 2026')).toBeInTheDocument();
  });

  it('carries the machine-readable value alongside the readable one', () => {
    render(<DateValue value={toBusinessDate('2026-10-04')} />);

    expect(screen.getByText('4 Oct 2026').getAttribute('datetime')).toBe('2026-10-04');
  });

  it('renders an instant in the business timezone, not the viewer"s', () => {
    // 2026-10-04T21:30Z is already the 5th in Kampala (UTC+3).
    render(
      <DateValue
        value="2026-10-04T21:30:00Z"
        variant="datetime"
        timeZone="Africa/Kampala"
      />,
    );

    expect(screen.getByText(/5 Oct 2026, 00:30/)).toBeInTheDocument();
  });

  it('keeps a date on one line', () => {
    render(<DateValue value={toBusinessDate('2026-10-04')} />);

    expect(screen.getByText('4 Oct 2026').className).toContain('whitespace-nowrap');
  });

  it('shows a dash for a date that was never recorded', () => {
    render(<DateValue value={null} />);

    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('empty, error and forbidden states', () => {
  it('states what is empty and offers the next step', () => {
    render(
      <EmptyState
        title="No clients yet"
        description="Register the first borrower to start lending."
        action={{ href: '/clients/new', label: 'Register a client' }}
      />,
    );

    expect(screen.getByText('No clients yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Register a client' })).toHaveAttribute(
      'href',
      '/clients/new',
    );
  });

  it('never implies a figure', () => {
    // "No payments" is not "UGX 0". An empty state that renders a zero is
    // making a financial claim the records do not support.
    render(<EmptyState title="No payments match this filter" />);

    expect(screen.queryByText(/UGX/)).toBeNull();
    expect(document.querySelector('[data-money]')).toBeNull();
  });

  it('announces an error without being asked to look for it', () => {
    render(<ErrorState title="Could not load the report" />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('offers a retry only when one is passed', () => {
    const { unmount } = render(<ErrorState title="Network problem" kind="network" />);
    expect(screen.queryByRole('button')).toBeNull();
    unmount();

    render(
      <ErrorState
        title="Network problem"
        kind="network"
        retry={<button type="button">Try again</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('refuses without saying whether the record exists', () => {
    // A 403 that confirms a loan number has leaked a loan number.
    render(<ForbiddenState action="open this loan" />);

    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toMatch(/your role does not allow/i);
    expect(text).not.toMatch(/exist|found|missing/i);
  });
});

/**
 * The invariant the rollout bought, swept across the whole application.
 *
 * Phase 9 replaced 200-odd `{formatUgx(...)}` expressions with `<Money>`. The
 * value of that is only preserved if new screens do the same, so this asserts
 * the pattern is gone rather than merely reduced — a reviewer reading a diff
 * cannot see that one new cell went back to the old way, and this can.
 */
describe('how the application renders money, dates and phone numbers', () => {
  const screens = globSync('{app,components}/**/*.tsx', { cwd: process.cwd() }).filter(
    (file) => !file.startsWith('components/ui/'),
  );

  /**
   * A sentence may still interpolate a figure: `` `Charged ${formatUgx(x)}` ``
   * is a string on its way into a hint or a button label, and a string cannot
   * be told not to break because it is not an element. What must not come
   * back is the *rendered* form — `{formatUgx(x)}` standing alone as a child
   * or as a prop — because that is the one that put a bare `UGX` on its own
   * line on every row of the payments register.
   */
  const rendersBare = (source: string, fn: string): boolean =>
    new RegExp(String.raw`(?<!\$)\{\s*` + fn + String.raw`\(`).test(source);

  it('renders no money through a bare formatter in JSX', () => {
    const offenders = screens.filter((file) =>
      rendersBare(readFileSync(join(process.cwd(), file), 'utf8'), 'formatUgx'),
    );

    expect(offenders).toEqual([]);
  });

  it('renders no date through a bare formatter in JSX', () => {
    const offenders = screens.filter((file) => {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      return (
        rendersBare(source, 'formatBusinessDate') || rendersBare(source, 'formatInstant')
      );
    });

    expect(offenders).toEqual([]);
  });

  it('uses no second phone format anywhere', () => {
    // `formatUgandanPhoneLocal` still exists — exports and receipts may want
    // the local form one day — but no screen reaches for it, so the directory
    // and the overdue page cannot disagree again.
    const offenders = screens.filter((file) =>
      readFileSync(join(process.cwd(), file), 'utf8').includes('formatUgandanPhoneLocal'),
    );

    expect(offenders).toEqual([]);
  });

  it('scans a meaningful number of screens', () => {
    // Guards the three assertions above against a glob that silently matches
    // nothing and passes vacuously.
    expect(screens.length).toBeGreaterThan(50);
  });
});
