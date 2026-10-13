/**
 * Every report, as data.
 *
 * ## The duplication this removes
 *
 * A report used to exist in five places that each had to be remembered: the
 * page that rendered it, the export route that re-ran it, the CSV column
 * builder, the `REPORTS` array on the index screen, and the capability list
 * repeated in each. Adding one meant touching all five, and the failure mode
 * was never a crash — it was an index that did not list a report, or an export
 * route whose capability list had drifted from its page's, which is a security
 * defect that looks like a typo.
 *
 * So a report is declared once, here, and everything else is derived: the
 * index lists `REPORTS`, the export handler looks up the entry by id, the
 * fields drive both the CSV and the PDF, and `needs` is read by the page and
 * the route from the same place rather than written twice.
 *
 * ## No `server-only`, and no data imports
 *
 * This module holds metadata. Its imports from `lib/data/reports` and
 * `lib/data/security` are type-only and erased at build time, so the registry
 * stays readable from a test environment — which is what lets
 * `tests/integration/report-routes.test.ts` check each entry's capability list
 * against a pinned expectation, and assert that every entry has a page and an
 * export route. The loaders, which do reach the database, live in `export.ts`
 * behind its own marker.
 *
 * Two properties need no test. A duplicate id is impossible, because the ids
 * are this object's keys. And a report that would export an identification
 * number cannot be added at all: `define` refuses it at module load, so the
 * application fails to start rather than producing such a file (§76).
 */

import {
  AlertTriangle,
  Banknote,
  Clock,
  HandCoins,
  Layers,
  Receipt,
  ShieldCheck,
  Users,
  UserCheck,
  type LucideIcon,
} from 'lucide-react';

import { ROUTES } from '@/config/app';
import type { Permission } from '@/lib/permissions';
import type { ReportPeriod } from '@/lib/domain/reporting';
import type {
  ArrearsReportRow,
  ClientReportRow,
  CollectionRow,
  PenaltyReportRow,
  PortfolioRow,
} from '@/lib/data/reports';

import { assertNoIdentityField, type ReportField } from './columns';
import type {
  AgingRow,
  CollateralItem,
  GuarantorExposureRow,
  RecoveryAction,
} from '@/lib/data/security';

import {
  agingFields,
  arrearsFields,
  clientFields,
  collateralFields,
  collectionFields,
  guarantorFields,
  penaltyFields,
  portfolioFields,
  recoveryFields,
} from './fields';

export const REPORT_GROUPS = ['money-in', 'behind', 'book', 'security'] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];

/**
 * Is this a group the registry knows?
 *
 * The rail's Reports entries pin `?group=`, and the index reads it back to
 * show one group. Whitelisted here rather than trusted, so a hand-edited
 * query string narrows to nothing it should not — it falls back to the whole
 * listing instead.
 */
export function isReportGroup(value: unknown): value is ReportGroup {
  return (
    typeof value === 'string' && (REPORT_GROUPS as readonly string[]).includes(value)
  );
}

export const REPORT_GROUP_LABELS: Readonly<
  Record<ReportGroup, { readonly title: string; readonly blurb: string }>
> = {
  'money-in': {
    title: 'Money received',
    blurb: 'What has actually been collected, and by which method.',
  },
  behind: {
    title: 'Loans behind',
    blurb: 'Who is late, by how much, and what it has cost them.',
  },
  book: {
    title: 'The book',
    blurb: 'Every loan and every borrower, with what each one owes.',
  },
  security: {
    title: 'What stands behind the book',
    blurb: 'The guarantees given and the security held against the lending.',
  },
};

/**
 * A period shortcut the index offers, where the report takes one.
 *
 * The report decides what a period *means*; these only pre-set the filter it
 * already has, which is why they are three links rather than three reports.
 */
export const PERIOD_SHORTCUTS = [
  { label: 'Today', value: 'today' },
  { label: 'This week', value: 'week' },
  { label: 'This month', value: 'month' },
] as const;

export interface ReportDefinition<Row> {
  /** The URL segment and the lookup key. One string, so they cannot differ. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly group: ReportGroup;
  readonly icon: LucideIcon;
  /** Every capability the report needs. All of them, not any of them. */
  readonly needs: readonly Permission[];
  /**
   * The query parameters that are this report's filters, which is what an
   * export link carries forward. A parameter not on this list is not sent,
   * so `?page=3` cannot reach a file that is supposed to hold every row.
   */
  readonly filterKeys: readonly string[];
  /** Where the date range opens, for a report that takes one. */
  readonly defaultPeriod?: ReportPeriod;
  /** The columns, which drive the CSV, the PDF and the screen alike. */
  readonly fields: (
    timeZone: string,
    options: { readonly withRemarks: boolean },
  ) => readonly ReportField<Row>[];
  /** Forced orientation, where the width heuristic would get it wrong. */
  readonly orientation?: 'portrait' | 'landscape';
  /** The stem of the downloaded file, before the range and the extension. */
  readonly fileStem: string;
  /**
   * The operational screen that acts on the same rows, where there is one.
   *
   * A report is for accounting: totalled, printable, exportable, with a
   * letterhead on it. The operational screen is for *doing* — go and collect
   * from this person today. They read the same data and they are not the same
   * job, so each report that has a counterpart says so rather than leaving
   * somebody to work out which of two similar screens they wanted.
   */
  readonly actOn?: { readonly href: string; readonly label: string };
}

function define<Row>(definition: ReportDefinition<Row>): ReportDefinition<Row> {
  // At module load, so a report that would export an identification number
  // cannot be added at all — the failure is here and in a test, never in a
  // file somebody has already downloaded. §76.
  assertNoIdentityField(definition.id, definition.fields('UTC', { withRemarks: true }));

  return definition;
}

export const REPORTS = {
  collections: define<CollectionRow>({
    id: 'collections',
    title: 'Collections',
    description:
      'Payments received over a date range, by day, week or month and by method. Reversed payments are listed and excluded from the totals.',
    group: 'money-in',
    icon: Receipt,
    needs: ['reports:view_operational', 'payments:view'],
    filterKeys: ['period', 'from', 'to', 'method', 'clientId', 'loanId', 'query'],
    defaultPeriod: 'today',
    fields: (timeZone) => collectionFields(timeZone),
    fileStem: 'collections',
    actOn: { href: ROUTES.payments, label: 'the payment register' },
  }),

  loans: define<PortfolioRow>({
    id: 'loans',
    title: 'Loan portfolio',
    description:
      'Every loan with its contract, what has been paid, what is outstanding and its two statuses. The active and cleared registers are this report under a status filter.',
    group: 'book',
    icon: Banknote,
    needs: ['reports:view_financial', 'loans:view'],
    filterKeys: ['period', 'from', 'to', 'status', 'state', 'clientId', 'query'],
    defaultPeriod: 'month',
    fields: (timeZone) => portfolioFields(timeZone),
    fileStem: 'loan-portfolio',
    actOn: { href: ROUTES.loans, label: 'the loan register' },
  }),

  arrears: define<ArrearsReportRow>({
    id: 'arrears',
    title: 'Arrears',
    description:
      'Every loan that is behind: what is overdue, how late, how many collections were missed, and the latest note on the client.',
    group: 'behind',
    icon: AlertTriangle,
    needs: ['reports:view_operational', 'delinquency:view'],
    filterKeys: ['state', 'sort', 'clientId', 'query'],
    fields: (timeZone, options) => arrearsFields(timeZone, options),
    fileStem: 'arrears',
    actOn: { href: ROUTES.overdue, label: "today's overdue list" },
  }),

  grace: define<ArrearsReportRow>({
    id: 'grace',
    title: 'Grace period',
    description:
      'Who can still settle with no charge, and by when. A loan leaves this report the day its grace period ends.',
    group: 'behind',
    icon: Clock,
    needs: ['reports:view_operational', 'delinquency:view'],
    filterKeys: [],
    fields: (timeZone, options) => arrearsFields(timeZone, options),
    fileStem: 'grace-period',
    actOn: { href: ROUTES.overdue, label: "today's overdue list" },
  }),

  penalties: define<PenaltyReportRow>({
    id: 'penalties',
    title: 'Late-payment charges',
    description:
      'Every charge raised, with the arithmetic that produced it: what was outstanding at the deadline, the rate applied, and what has been paid against it.',
    group: 'behind',
    icon: HandCoins,
    needs: ['reports:view_financial', 'penalties:view'],
    filterKeys: [],
    fields: (timeZone) => penaltyFields(timeZone),
    fileStem: 'late-payment-charges',
  }),

  clients: define<ClientReportRow>({
    id: 'clients',
    title: 'Clients',
    description:
      'The borrower directory with each one’s outstanding balance, arrears and status beside them.',
    group: 'book',
    icon: Users,
    needs: ['reports:view_operational', 'clients:view'],
    filterKeys: ['clientStatus', 'query'],
    fields: (timeZone) => clientFields(timeZone),
    fileStem: 'clients',
    actOn: { href: ROUTES.clients, label: 'the client register' },
  }),
  aging: define<AgingRow>({
    id: 'aging',
    title: 'Aging and portfolio at risk',
    description:
      'The live book bucketed by how late it is \u2014 1\u20137, 8\u201330, 31\u201360, 61\u201390 and over 90 days \u2014 with the principal in each bucket. The PAR ratios the buckets produce are on the Debt & Security screen.',
    group: 'behind',
    icon: Layers,
    needs: ['reports:view_financial', 'delinquency:view'],
    filterKeys: ['bucket', 'productId', 'branchId', 'query'],
    fields: () => agingFields(),
    fileStem: 'aging',
    actOn: { href: ROUTES.recovery, label: 'Debt & Security' },
  }),

  recovery: define<RecoveryAction>({
    id: 'recovery',
    title: 'Recovery file',
    description:
      'Every call, visit, message, notice and promise recorded against a loan, in the order it happened. A promise\u2019s verdict is read from the posted payments each time the report is run, never stored.',
    group: 'behind',
    icon: HandCoins,
    needs: ['reports:view_operational', 'recovery:view'],
    filterKeys: ['kind', 'promiseStatus', 'query'],
    fields: (timeZone) => recoveryFields(timeZone),
    fileStem: 'recovery-file',
    actOn: { href: ROUTES.recovery, label: 'Debt & Security' },
  }),

  guarantors: define<GuarantorExposureRow>({
    id: 'guarantors',
    title: 'Guarantor exposure',
    description:
      'Every guarantee given: who gave it, whether they are an existing borrower or somebody external, what they stood behind, what that loan still owes, and whether the guarantee has been released.',
    group: 'security',
    icon: UserCheck,
    needs: ['reports:view_financial', 'guarantors:view'],
    filterKeys: ['subjectKind', 'guaranteeStatus', 'productId', 'query'],
    fields: (timeZone) => guarantorFields(timeZone),
    fileStem: 'guarantor-exposure',
    actOn: { href: ROUTES.guarantorRegister, label: 'the guarantor register' },
  }),

  collateral: define<CollateralItem>({
    id: 'collateral',
    title: 'Security held',
    description:
      'Every item taken as security, with its valuation, where it is kept, its ownership document, and \u2014 where it has been sold \u2014 what it fetched. The valuation total covers what is still held, not everything ever taken in.',
    group: 'security',
    icon: ShieldCheck,
    needs: ['reports:view_financial', 'collateral:view'],
    filterKeys: ['status'],
    fields: (timeZone) => collateralFields(timeZone),
    fileStem: 'security-held',
    actOn: { href: ROUTES.recovery, label: 'Debt & Security' },
  }),
} as const;

export type ReportId = keyof typeof REPORTS;

export const REPORT_IDS = Object.keys(REPORTS) as readonly ReportId[];

export function isReportId(value: unknown): value is ReportId {
  return typeof value === 'string' && value in REPORTS;
}

/** The report's own page. Derived from the id, so a link cannot go stale. */
export function reportHref(id: ReportId): string {
  return `${ROUTES.reports}/${id}`;
}

/** The export URL, with the filters the screen had and the format asked for. */
export function reportExportHref(
  id: ReportId,
  format: 'csv' | 'pdf',
  filterQuery: string,
): string {
  const query = new URLSearchParams(filterQuery);
  query.set('format', format);
  return `${reportHref(id)}/export?${query.toString()}`;
}
