import { render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { AuditLog } from '@/components/audit/audit-log';
import { PaymentRecorded } from '@/components/payments/payment-recorded';
import { PageHeader, ActionLink, SectionHeader } from '@/components/ui/page-header';
import type { AuditEntry } from '@/lib/domain/audit';
import {
  PERIOD_SHORTCUTS,
  REPORTS,
  REPORT_GROUPS,
  REPORT_GROUP_LABELS,
  REPORT_IDS,
} from '@/lib/reports/registry';

/**
 * The four screens the pre-Phase-9 review called out as weak or unfinished,
 * and the page-header pattern that replaced three different action styles.
 */

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const read = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');

/** Source with its comments removed, for assertions about what a screen says. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------------------------------------------------------------------------
// Payment success
// ---------------------------------------------------------------------------

const RECORDED = {
  paymentNumber: 'PAY260162',
  amount: 29_741,
  clientName: 'Mugisha Robert Tumwine',
  clientId: 'b5fd8dda-a8d3-416e-927c-d2f8663513a1',
  loanNumber: 'LN260004',
  loanId: 'c69d0276-d540-45a0-9ffa-ca9463babaa9',
  paymentMethod: 'cash' as const,
  receivedAt: '2026-10-04T11:32:00Z',
  outstandingAfter: 356_903,
  timeZone: 'Africa/Kampala',
};

describe('the payment success state', () => {
  it('states every figure the specification asks for', () => {
    // It replaced a green bar reading "Payment recorded." on an empty page.
    render(<PaymentRecorded {...RECORDED} />);

    expect(screen.getByText(/Payment recorded/)).toBeInTheDocument();
    expect(screen.getByText('PAY260162')).toBeInTheDocument();
    expect(screen.getByText('UGX 29,741')).toBeInTheDocument();
    expect(screen.getByText('Mugisha Robert Tumwine')).toBeInTheDocument();
    expect(screen.getByText('LN260004')).toBeInTheDocument();
    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.getByText('UGX 356,903')).toBeInTheDocument();
  });

  it('offers the next steps a cashier actually takes', () => {
    render(<PaymentRecorded {...RECORDED} />);

    expect(screen.getByRole('link', { name: /View receipt/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Print receipt/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Record another payment/ })).toHaveAttribute(
      'href',
      '/payments/new',
    );
    expect(screen.getByRole('link', { name: /Back to borrower/ })).toHaveAttribute(
      'href',
      `/clients/${RECORDED.clientId}`,
    );
    expect(screen.getByRole('link', { name: /Back to loan/ })).toHaveAttribute(
      'href',
      `/loans/${RECORDED.loanId}`,
    );
  });

  it('derives nothing from the query string', () => {
    // §12. A confirmation assembled from query parameters is one anybody can
    // forge by editing the address bar. The page reads the payment by id and
    // the flag decides only whether the panel appears.
    const page = read('app/(app)/payments/[paymentId]/page.tsx');

    expect(page).toContain("query.recorded === '1'");

    const panel = /<PaymentRecorded([\s\S]*?)\/>/.exec(page)?.[1] ?? '';
    expect(panel).not.toBe('');

    // Every prop comes off the loaded record, not off `query`.
    for (const line of panel.split('\n').filter((l) => l.includes('={'))) {
      expect(line, line.trim()).toMatch(/=\{(payment|branding)\./);
    }
  });

  it('leaves the form behind so a reload cannot re-post', () => {
    // §69. `replace`, so the form's URL is not in history for the back button
    // to offer.
    const form = read('components/payments/payment-form.tsx');

    expect(form).toContain('router.replace(');
    expect(form).not.toContain('router.push(');
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('the settings page', () => {
  const page = read('app/(app)/settings/page.tsx');

  it('carries no development-phase text', () => {
    // It used to read "the settings screens arrive with Phase 2" while the
    // sidebar beside it said Phase 8.
    //
    // Comments are stripped first: §112 removes phase labels from
    // production-facing *screens* and keeps the history in the source, and a
    // check that forbade the word everywhere would forbid explaining why the
    // screen changed.
    expect(withoutComments(page)).not.toMatch(/Phase \d/);
    expect(page).not.toContain('PhasePlaceholder');
    expect(withoutComments(page)).not.toMatch(/not available yet/i);
  });

  it('reads the real configuration rather than a constant', () => {
    expect(page).toContain('getSettingsSnapshot');
    expect(page).toContain('rules.defaultMonthlyInterestRateBps');
    expect(page).toContain('rules.gracePeriodDays');
    expect(page).toContain('rules.penaltyRateBps');
  });

  it('says that a change does not re-price an existing loan', () => {
    // The single most important sentence a settings screen in a lending
    // system can carry: an approved loan keeps the rate, grace period and
    // penalty rate captured at approval.
    expect(page).toMatch(/does not change an existing loan/i);
    expect(page).toMatch(/approved after the change|after<\/strong> the change/i);
  });

  it('separates what is editable from what is a historical snapshot', () => {
    expect(page).toContain('Read-only');
    expect(page).toMatch(/Only the Owner/);
  });
});

// ---------------------------------------------------------------------------
// Reports hub
// ---------------------------------------------------------------------------

describe('the reports hub', () => {
  const page = read('app/(app)/reports/page.tsx');

  /*
   * Phase 16 moved the hub's own array of reports — titles, groups, period
   * chips, capabilities — into `lib/reports/registry.ts`, because the same
   * facts existed here, in each page's guard and in each export route. These
   * three assertions follow it there, which makes them stronger: they now
   * check the single declaration rather than one of four copies of it.
   */

  it('groups the reports rather than listing a dozen identical cards', () => {
    expect([...REPORT_GROUPS]).toContain('money-in');
    expect([...REPORT_GROUPS]).toContain('behind');
    expect([...REPORT_GROUPS]).toContain('book');

    // Every report belongs to a group that has a heading, or it renders in a
    // section with no title.
    for (const id of REPORT_IDS) {
      expect([...REPORT_GROUPS], id).toContain(REPORTS[id].group);
      expect(REPORT_GROUP_LABELS[REPORTS[id].group].title.length).toBeGreaterThan(0);
    }

    expect(page).toContain('REPORT_GROUP_LABELS');
  });

  it('offers period shortcuts on the reports that take a period', () => {
    expect(PERIOD_SHORTCUTS.map((period) => period.value)).toStrictEqual([
      'today',
      'week',
      'month',
    ]);

    // The chips appear only where the report has a date range to pre-set.
    // Offering "This week" on a report that ignores it would be a control
    // that does nothing.
    expect(REPORTS.collections.defaultPeriod).toBe('today');
    expect(REPORTS.penalties.defaultPeriod).toBeUndefined();
    expect(page).toContain('report.defaultPeriod === undefined');
  });

  it('reads its headline figures from the dashboard summaries', () => {
    // Not a second query with its own interpretation. A hub that disagreed
    // with the dashboard about today's takings would be worse than one with
    // no figures at all.
    expect(page).toContain('getCollectionSummary');
    expect(page).toContain('getPortfolioSummary');
  });

  it('shows a financial figure only to a role that may see it', () => {
    expect(page).toContain("contextCan(context, 'reports:view_financial')");
    expect(page).toContain("contextCan(context, 'payments:view')");
  });

  it('still requires every capability a report needs before listing it', () => {
    // `needs` is a conjunction. A report listed without its data capability
    // is an invitation to a blank page, and a blank page is how somebody
    // concludes the system is broken rather than that they are not entitled.
    expect(page).toContain('REPORTS[id].needs.every(');

    // And every report declares at least the reporting capability plus the
    // capability of the data it renders — never one alone.
    for (const id of REPORT_IDS) {
      expect(REPORTS[id].needs.length, id).toBeGreaterThanOrEqual(2);
      expect(
        REPORTS[id].needs.some((permission) => permission.startsWith('reports:')),
        id,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry =>
  ({
    id: 1,
    occurredAt: '2026-10-04T11:24:00Z',
    action: 'auth.signed_in',
    entityType: 'auth_session',
    entityId: 'abc',
    actorLabel: 'Nalubega Sarah Kiwanuka',
    actorProfileId: 'p1',
    oldValues: null,
    newValues: null,
    metadata: null,
    ...overrides,
  }) as AuditEntry;

describe('the audit trail', () => {
  it('renders a table on a desktop, not one card per entry', () => {
    // Twenty-five one-line events used nearly 7,000px as cards.
    render(<AuditLog entries={[entry(), entry({ id: 2 })]} timeZone="Africa/Kampala" />);

    const table = screen.getByRole('table');
    expect(table).toBeInTheDocument();

    for (const heading of ['When', 'Action', 'Record', 'Done by', 'Detail']) {
      expect(within(table).getByText(heading)).toBeInTheDocument();
    }
  });

  it('keeps the header visible while a long log scrolls', () => {
    render(<AuditLog entries={[entry()]} timeZone="Africa/Kampala" />);

    expect(screen.getByRole('table').getAttribute('data-sticky-header')).toBe('');
  });

  it('offers a disclosure only on a row that has something behind it', () => {
    // The old page put "What changed" on every card, including the ones with
    // nothing behind it, which taught people it was never worth opening.
    const { unmount } = render(
      <AuditLog entries={[entry()]} timeZone="Africa/Kampala" />,
    );
    expect(screen.queryByText('What changed')).toBeNull();
    unmount();

    render(
      <AuditLog
        entries={[entry({ newValues: { status: 'active' } })]}
        timeZone="Africa/Kampala"
      />,
    );
    expect(screen.getAllByText('What changed').length).toBeGreaterThan(0);
  });

  it('keeps a compact card list for phones', () => {
    const { container } = render(
      <AuditLog entries={[entry()]} timeZone="Africa/Kampala" />,
    );

    // Five columns do not fit in 390px, and a horizontally scrolling log is
    // worse than a tall one.
    expect(container.querySelector('ul.md\\:hidden')).not.toBeNull();
  });

  it('offers nothing that writes', () => {
    const source = read('components/audit/audit-log.tsx');

    for (const forbidden of ['action=', 'onSubmit', '<form', 'Action(']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('says so when nothing matches', () => {
    render(<AuditLog entries={[]} timeZone="Africa/Kampala" />);

    expect(screen.getByText('No audit records match')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The page-header pattern
// ---------------------------------------------------------------------------

describe('page-level actions', () => {
  it('renders one primary action, as a link that looks like a button', () => {
    render(
      <PageHeader
        title="Clients"
        description="Search by name."
        primaryAction={<ActionLink href="/clients/new">Register client</ActionLink>}
      />,
    );

    const action = screen.getByRole('link', { name: 'Register client' });
    expect(action.className).toContain('bg-accent');
  });

  it('puts the back link above the title, as a link rather than a button', () => {
    render(<PageHeader title="Loan" back={{ href: '/loans', label: 'Loans' }} />);

    const back = screen.getByRole('link', { name: /Loans/ });
    expect(back.className).not.toContain('bg-accent');
  });

  it('is used by every page that has a page-level action', () => {
    // The review found "Add staff member" as a filled button and "Register
    // client", "New loan" and "Record a payment" as bare text in the same
    // position. One pattern, one place.
    for (const page of [
      'app/(app)/clients/page.tsx',
      'app/(app)/loans/page.tsx',
      'app/(app)/payments/page.tsx',
      'app/(app)/users/page.tsx',
      'app/(app)/overdue/page.tsx',
      'app/(app)/settings/page.tsx',
      'app/(app)/reports/page.tsx',
    ]) {
      const source = read(page);
      expect(source, page).toContain('<PageHeader');
      // No page may hand-roll the action styling again.
      expect(source, `${page} hand-rolled action`).not.toMatch(
        /className="bg-(accent|brand-600)[^"]*"\s*\n?\s*>\s*\n?\s*(Register|New|Record|Add)/,
      );
    }
  });

  it('gives a section heading a visible step above a card title', () => {
    render(<SectionHeader title="Business summary" />);

    const heading = screen.getByRole('heading', { name: 'Business summary' });

    // The size is carried by the design system's role class rather than a
    // pair of text utilities: `.t-section-title` is 1.125rem rising to
    // 1.25rem at `md`, against `.t-card-title`'s 0.9375rem. Asserting the
    // role is the stronger claim — a utility can be overridden by the next
    // class in the string, whereas the role class is the hierarchy itself.
    expect(heading.className).toContain('t-section-title');

    // And the step is real: the two roles do not resolve to the same size.
    const css = read('app/globals.css');
    const sectionSize = /\.t-section-title\s*\{[^}]*font-size:\s*([\d.]+)rem/.exec(css);
    const cardSize = /\.t-card-title\s*\{[^}]*font-size:\s*([\d.]+)rem/.exec(css);

    expect(sectionSize).not.toBeNull();
    expect(cardSize).not.toBeNull();
    expect(Number(sectionSize?.[1])).toBeGreaterThan(Number(cardSize?.[1]));
  });
});

// ---------------------------------------------------------------------------
// The colour token that did not exist
// ---------------------------------------------------------------------------

describe('the accent token', () => {
  const css = read('app/globals.css');

  it('is defined, in both themes', () => {
    // 117 class references used it before it existed. Tailwind emits nothing
    // for an undefined token and reports no error, so `bg-accent` on the
    // "New loan" button produced a button with no background.
    const light = css.slice(
      css.indexOf(':root {'),
      css.indexOf('@media (prefers-color-scheme: dark)'),
    );
    const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));

    for (const token of [
      '--color-accent',
      '--color-accent-contrast',
      '--color-accent-surface',
    ]) {
      expect(light, `${token} (light)`).toContain(token);
      expect(dark, `${token} (dark)`).toContain(token);
    }
  });

  it('is exported to Tailwind, so the utility classes exist', () => {
    const inline = css.slice(css.indexOf('@theme inline'));

    expect(inline).toContain('--color-accent: var(--color-accent)');
    expect(inline).toContain('--color-accent-contrast: var(--color-accent-contrast)');
  });

  it('is spelled one way across the application', () => {
    // `text-accent-foreground` appeared on three pages and resolved to
    // nothing, because the token is `accent-contrast`.
    const screens =
      read('app/(app)/payments/page.tsx') + read('app/(app)/loans/page.tsx');
    expect(screens).not.toContain('accent-foreground');
  });
});
