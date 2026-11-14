import {
  BadgeCheck,
  Banknote,
  CalendarDays,
  Bell,
  ChartColumn,
  Landmark,
  LayoutDashboard,
  Network,
  HandCoins,
  PiggyBank,
  Receipt,
  Settings,
  HeartHandshake,
  ShieldAlert,
  Smartphone,
  UserCircle,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { ROUTES } from '@/config/app';
import type { Permission } from '@/lib/permissions';

/**
 * One destination in a menu.
 *
 * `href` may carry a query string and a fragment. Most of this rail is
 * **filtered views of screens that already read those filters** — the loan
 * register's ten workflow stages, the client register's statuses, Debt &
 * Security's five views, the collection summary's five slices — because a
 * label does not earn a route. `navPath` and `navQuery` split an href back
 * apart for the two jobs that need the pieces: matching the capability map,
 * and deciding which single entry is the page being viewed.
 */
export interface NavItem {
  readonly href: string;
  readonly label: string;
  /**
   * Shorter label for a bottom-bar cell.
   *
   * Only the borrower portal renders a bar, so only its entries need one; the
   * staff rail carries full labels at every width.
   */
  readonly shortLabel?: string;
  readonly icon?: LucideIcon;
  /**
   * The capability that opens the *route* behind this entry.
   *
   * The same map the route guard reads, so a visible link and a protected
   * route cannot disagree. Asserted against `permissionForPath` by the
   * navigation parity test, on the path — a query string is a filter, not a
   * permission.
   */
  readonly permission: Permission;
  /**
   * Further capabilities the destination itself demands, beyond the one its
   * route prefix requires.
   *
   * `/loans/new` sits under the `loans:view` prefix and guards `loans:create`.
   * `/reports/penalties` sits under `reports:view_operational` and guards
   * `reports:view_financial` and `penalties:view`. `/guarantors/register`
   * sits under `guarantors:view` and reads the narrower ones itself. Listing
   * them here means the rail offers no entry that would refuse the person who
   * clicks it, while `permission` stays exactly what the prefix map says.
   *
   * Hiding is never the protection. The pages guard themselves and Row Level
   * Security refuses the rows; this only stops staff clicking into a refusal.
   */
  readonly requires?: readonly Permission[];
  /** The delivery phase that implements this destination. */
  readonly phase: number;
  /** Rank in a bottom bar, lowest first. Portal only. */
  readonly bottomBarRank?: number;
  /**
   * Whether the rail prefetches this destination. Defaults to on.
   *
   * Phase 14's reason, and it still holds: prefetching a dynamic route runs
   * the page server-side, and Debt & Security reads a grouping-sets aggregate
   * over the whole active book. Every visit to any screen would have computed
   * the portfolio's PAR whether or not anybody looked at it.
   *
   * Collapsing the rail into modules reduced the pressure sharply — a closed
   * module renders no links at all, so a cold load now prefetches the
   * dashboard and nothing else — but the opt-out stays on the entries whose
   * destination is expensive to render, because opening that module should
   * not fire five aggregates either.
   */
  readonly prefetch?: boolean;
}

/**
 * A collapsible module in the staff rail.
 *
 * The rail used to carry four broad blocks — Operations, Finance, Insights,
 * Administration — with every destination inside them and all of them open.
 * By Phase 17 that had become twenty flat rows in which lending, collections,
 * arrears, recovery and notifications were one undifferentiated list under
 * "Operations", and the reporting surface — ten reports, an export pipeline
 * and three capabilities of its own — read as a single link under "Insights".
 *
 * These are the business's own divisions instead, each closed until somebody
 * asks for it.
 */
/**
 * A collapsible branch *inside* a module: the rail's third level, and with a
 * nested `groups`, its fourth.
 *
 * ## Why the rail grew a level
 *
 * The Agency module had fourteen entries in one flat list: a counter screen, a
 * verification queue, two reconciliations, a commission screen, a remittance
 * screen, a Mobile Money screen, a provider register and a line register, all
 * siblings. Nothing in it said that recording a customer's deposit and
 * configuring a bank are different kinds of act, or that MTN and Airtel are
 * two businesses rather than one link called "Mobile Money". A reader looking
 * for "Stanbic's agent accounts" had no row to aim at and no reason to think
 * the application held the answer.
 *
 * The client's confirmed requirements are explicit that Agent Banking and
 * Mobile Money are separate operational modules, each with its own providers,
 * accounts, transactions, float, commissions and reports. That is a tree, and
 * a tree does not fit in two levels.
 *
 * ## Data-driven, and only where the data is the structure
 *
 * `items` is static: the operations a module offers do not depend on what is
 * registered. `groups` may be either — the Agency branch's static groups are
 * declared below, and the per-bank, per-provider and per-line groups are built
 * from the database by `agencyNavGroups()`, because which banks exist and which
 * lines are registered is business data and hard-coding it is how STANBIC
 * becomes the only bank the application can ever have.
 *
 * A dynamic group carries **no icon**. A Lucide icon is a React component and
 * a component cannot be passed from a Server Component to a Client Component,
 * so anything resolved server-side must be plain serialisable data. The
 * static groups above them carry the icons that name the branch.
 */
export interface NavGroup {
  /**
   * Stable within the whole rail, because it is what "which groups are open"
   * is keyed on. Dynamic groups derive theirs from the provider code or the
   * account id rather than from a position in a list, so re-ordering the data
   * does not move somebody's open branch.
   */
  readonly id: string;
  readonly label: string;
  readonly icon?: LucideIcon;
  /**
   * A short line under the label — a float balance, a status, a count.
   *
   * Only dynamic groups use it, and only for a fact the reader needs before
   * they click: that a line is suspended, or that a bank has no accounts yet.
   */
  readonly note?: string;
  /** The destinations directly inside this group. */
  readonly items: readonly NavItem[];
  /** Branches inside this branch. */
  readonly groups?: readonly NavGroup[];
  /**
   * Shown in place of the group's contents when it has none.
   *
   * A registered provider with no agent accounts yet is a real and common
   * state, and a branch that opened onto nothing would read as a fault. The
   * empty state says what is missing; the `items` that remain are how a
   * permitted reader fixes it.
   */
  readonly emptyLabel?: string;
}

export interface NavModule {
  readonly id: NavModuleId;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly items: readonly NavItem[];
  /** Collapsible branches below `items`. See `NavGroup`. */
  readonly groups?: readonly NavGroup[];
}

export const NAV_MODULE_IDS = [
  'clients',
  'membership',
  'savings',
  // Polytos Phase 3. After Savings, because a member loan is secured against
  // a savings balance and that is where a reader looks for it next, and before
  // Loans, because it is the membership programme's lending rather than the
  // whole book.
  'member_loans',
  // Polytos Phase 4. After Member Lending, because a benefit is the other
  // thing the membership programme pays out and that is where a reader looks
  // for it next; and before Loans, because both belong to the programme
  // rather than to the whole book.
  'benefits',
  'meetings',
  'loans',
  'collections',
  'debt',
  'finance',
  'agency',
  'reports',
  'branches',
  'administration',
] as const;

export type NavModuleId = (typeof NAV_MODULE_IDS)[number];

/**
 * How many destinations a bottom bar holds before "More".
 *
 * Four, not ten. The pre-Phase-9 bar tried to fit every entry across 390px
 * and produced labels reading `H…`, `Cli…`, `B…`. Only the borrower portal
 * renders a bar now, and it has two entries, but the rule is kept because the
 * portal is the thing that would break if it were deleted.
 */
export const BOTTOM_BAR_SLOTS = 4;

// ---------------------------------------------------------------------------
// The two standalone rows
// ---------------------------------------------------------------------------

/**
 * The dashboard, pinned above the modules as its own row.
 *
 * Reached often enough that opening a module to find it would be a cost.
 */
export const DASHBOARD_ITEM: NavItem = {
  href: ROUTES.dashboard,
  label: 'Dashboard',
  shortLabel: 'Home',
  icon: LayoutDashboard,
  permission: 'dashboard:view',
  phase: 1,
};

/**
 * Notifications, pinned below the modules as its own row.
 *
 * Standalone for the same reason as the dashboard and a different one
 * besides: the header's bell is how somebody reaches this most of the time,
 * and the row is for the person who wants the history and the filters. It
 * belongs to no module because it is *about* every module.
 *
 * The bell itself is untouched — it holds the five most recent unread, which
 * is what somebody standing at the counter needs.
 */
export const NOTIFICATIONS_ITEM: NavItem = {
  href: ROUTES.notifications,
  label: 'Notifications',
  shortLabel: 'Alerts',
  icon: Bell,
  permission: 'notifications:view',
  phase: 15,
};

// ---------------------------------------------------------------------------
// The modules
// ---------------------------------------------------------------------------

/**
 * Staff navigation, as the business's own modules.
 *
 * `docs/NAVIGATION-MAP.md` records every mapping, and the handful of labels
 * that were asked for and left out because this system has nothing behind
 * them yet.
 */
export const NAV_MODULES: readonly NavModule[] = [
  {
    id: 'clients',
    label: 'Clients',
    icon: Users,
    items: [
      {
        href: ROUTES.clients,
        label: 'Client Register',
        permission: 'clients:view',
        phase: 3,
      },
      {
        href: `${ROUTES.clients}/new`,
        label: 'New Client',
        permission: 'clients:view',
        requires: ['clients:create'],
        phase: 3,
      },
      {
        href: `${ROUTES.clients}?status=active`,
        label: 'Active Clients',
        permission: 'clients:view',
        phase: 3,
      },
      {
        href: `${ROUTES.clients}?status=inactive`,
        label: 'Inactive Clients',
        permission: 'clients:view',
        phase: 3,
      },
      {
        href: `${ROUTES.clients}?status=suspended`,
        label: 'Suspended Clients',
        permission: 'clients:view',
        phase: 3,
      },
      {
        href: `${ROUTES.clients}?status=blacklisted`,
        label: 'Blacklisted Clients',
        permission: 'clients:view',
        phase: 3,
      },
      {
        // The audit trail filtered to client records: who changed what, and
        // when. The only history of a client this system keeps.
        href: `${ROUTES.audit}?entity=client`,
        label: 'Client History',
        permission: 'audit:view',
        phase: 2,
      },
    ],
  },
  {
    // Polytos Phase 1. Membership, immediately after Clients, because a
    // membership is a fact about a client and that is where a reader looks
    // for it.
    //
    // Eight entries: enrolment, the register, its four status views, the
    // read-only configuration, and the audit trail filtered to membership.
    //
    // Phase 1 had no "Enrol member" entry, because a rail entry opening onto
    // a form that could not complete would have been the system telling a
    // clerk that members could be taken on. Polytos Phase 2 built enrolment,
    // so the entry is here — behind `membership:create`, so a Secretary who
    // may read the register is not offered a form they cannot submit.
    //
    // Savings have a module of their own rather than entries here: the work
    // is a register a counter lives in all day, and burying it two levels
    // down inside Membership would make the most-used screen in the phase
    // the hardest to reach. Benefit claims and the profit share are still
    // absent, and the rules behind both are undecided.
    id: 'membership',
    label: 'Membership',
    icon: BadgeCheck,
    items: [
      {
        href: ROUTES.membership,
        label: 'Membership Register',
        permission: 'membership:view',
        phase: 21,
      },
      {
        // `permission` stays what the route prefix map says — the path is
        // under `/membership`, so `membership:view` — and `requires` carries
        // what the page itself demands. The rail then offers no entry that
        // would refuse the person who clicks it.
        href: ROUTES.enrolMember,
        label: 'Enrol a Member',
        permission: 'membership:view',
        requires: ['membership:create'],
        phase: 22,
      },
      {
        href: `${ROUTES.membership}?status=active`,
        label: 'Active Members',
        permission: 'membership:view',
        phase: 21,
      },
      {
        href: `${ROUTES.membership}?status=pending`,
        label: 'Pending Applications',
        permission: 'membership:view',
        phase: 21,
      },
      {
        href: `${ROUTES.membership}?status=suspended`,
        label: 'Suspended Members',
        permission: 'membership:view',
        phase: 21,
      },
      {
        href: `${ROUTES.membership}?status=withdrawn`,
        label: 'Former Members',
        permission: 'membership:view',
        phase: 21,
      },
      {
        href: ROUTES.membershipPolicies,
        label: 'Membership Policy',
        permission: 'membership:view',
        phase: 21,
      },
      {
        // The audit trail filtered to membership records: who enrolled whom,
        // who changed a status, and when. The same shape the Clients module
        // gives its own history entry.
        href: `${ROUTES.audit}?entity=membership`,
        label: 'Membership History',
        permission: 'audit:view',
        phase: 21,
      },
    ],
  },
  {
    // Polytos Phase 2. Savings, immediately after Membership, because a
    // savings account belongs to a membership and that is where a reader
    // looks for it next.
    //
    // Five entries. The register is first because it is the screen a
    // Secretary spends the day in; the three status views mirror the shape
    // every other module uses; and the withdrawal queue is last and behind
    // `savings:approve_withdrawal`, because it is a different person's work —
    // a Manager's list of decisions, not a view of the register.
    //
    // There is no "Record a deposit" entry. A deposit is always to a
    // *particular* member's account, so the entry would open a chooser that
    // the register already is, one tap earlier.
    id: 'savings',
    label: 'Member Savings',
    icon: PiggyBank,
    items: [
      {
        href: ROUTES.savings,
        label: 'Savings Register',
        permission: 'savings:view',
        phase: 22,
      },
      {
        href: `${ROUTES.savings}?status=active`,
        label: 'Active Accounts',
        permission: 'savings:view',
        phase: 22,
      },
      {
        href: `${ROUTES.savings}?status=dormant`,
        label: 'Dormant Accounts',
        permission: 'savings:view',
        phase: 22,
      },
      {
        href: ROUTES.savingsWithdrawals,
        label: 'Withdrawal Requests',
        permission: 'savings:approve_withdrawal',
        phase: 22,
      },
      {
        // Who took a deposit, who approved a withdrawal, who reversed what.
        // The same shape the Clients and Membership modules give their own
        // history entries.
        href: `${ROUTES.audit}?entity=savings`,
        label: 'Savings History',
        permission: 'audit:view',
        phase: 22,
      },
    ],
  },
  {
    // Polytos Phase 3. Member lending.
    //
    // Four entries, and the first two are the two questions this section is
    // opened with: who can borrow, and who has borrowed. They are sidebar
    // entries rather than a strip of tabs above the register, which is the
    // Phase 21 decision restated — a strip would be a second copy of this
    // navigation, and the only one of the two that could fall out of step.
    //
    // There is no "Member Loan" detail entry. A member loan is a row in
    // `loans`, so it opens in the loan register like every other loan with a
    // membership panel on it; a second detail route would be a second set of
    // controls over one agreement.
    //
    // `member_loans:view_eligibility` on the reads, because an assessment is a
    // lending offer rather than a view of savings. `member_loans:create` on
    // the application, because opening one commits the business to lending
    // against member savings — which is why the Secretary/Treasurer sees the
    // first three entries and not the fourth.
    id: 'member_loans',
    label: 'Member Lending',
    icon: HandCoins,
    items: [
      {
        href: `${ROUTES.memberLoans}?tab=members`,
        label: 'Who Can Borrow',
        permission: 'member_loans:view_eligibility',
        phase: 23,
      },
      {
        href: `${ROUTES.memberLoans}?tab=loans`,
        label: 'Member Loans',
        permission: 'member_loans:view_eligibility',
        phase: 23,
      },
      {
        href: `${ROUTES.memberLoans}?tab=members&qualified=qualified`,
        label: 'Qualified Members',
        permission: 'member_loans:view_eligibility',
        phase: 23,
      },
      {
        href: ROUTES.newMemberLoan,
        label: 'New Application',
        permission: 'member_loans:create',
        phase: 23,
      },
    ],
  },
  {
    // Polytos Phase 4. Benefits.
    //
    // Seven entries, and the order is the order a claim moves: the dashboard,
    // the register, a new claim, the two queues, the payment history and the
    // beneficiary register.
    //
    // The two queues are sidebar entries behind the capability that works
    // them — `benefits:assess` for the claims waiting to be checked,
    // `benefits:approve` for the ones waiting for a decision, `benefits:pay`
    // for the money. That is three different people, and offering any of them
    // a screen the route guard refuses would teach them the system is
    // unreliable. The savings module learned this with its withdrawal queue.
    //
    // Beneficiaries are here as well as on the membership profile, and the
    // two answer different questions. The panel on a member's record is where
    // a nomination is taken. This entry answers "which members have an
    // unverified one" — and an unverified beneficiary is a bereavement
    // benefit that cannot be paid, which nobody discovers at a convenient
    // moment.
    id: 'benefits',
    label: 'Member Benefits',
    icon: HeartHandshake,
    items: [
      {
        href: ROUTES.benefits,
        label: 'Benefits Dashboard',
        permission: 'benefits:view',
        phase: 24,
      },
      {
        href: ROUTES.benefitClaims,
        label: 'Claims Register',
        permission: 'benefits:view',
        phase: 24,
      },
      {
        href: ROUTES.newBenefitClaim,
        label: 'New Claim',
        permission: 'benefits:view',
        requires: ['benefits:claim'],
        phase: 24,
      },
      {
        // Claims submitted and waiting for somebody to check the documents.
        href: `${ROUTES.benefitClaims}?status=submitted`,
        label: 'Awaiting Verification',
        permission: 'benefits:view',
        requires: ['benefits:assess'],
        phase: 24,
      },
      {
        href: ROUTES.benefitApprovals,
        label: 'Approval Queue',
        permission: 'benefits:approve',
        phase: 24,
      },
      {
        href: ROUTES.benefitPayments,
        label: 'Benefit Payments',
        permission: 'benefits:pay',
        phase: 24,
      },
      {
        href: ROUTES.benefitReports,
        label: 'Benefits Reports',
        permission: 'benefits:view',
        phase: 24,
      },
      {
        href: ROUTES.beneficiaries,
        label: 'Beneficiary Register',
        permission: 'beneficiaries:view',
        phase: 24,
      },
      {
        // Who recorded a beneficiary, who verified it, who assessed a claim
        // and who approved it. The same shape the Clients, Membership and
        // Savings modules give their own history entries.
        href: `${ROUTES.audit}?entity=benefit_claim`,
        label: 'Benefits History',
        permission: 'audit:view',
        phase: 24,
      },
    ],
  },
  {
    // Polytos Phase 4. Monthly meetings.
    //
    // Four entries. The calendar is first because the question this section
    // is opened with is almost always "when is the next one"; the upcoming
    // and past views are the two halves of that; and scheduling is behind
    // `meetings:manage`.
    //
    // There is nothing here about standing, attendance thresholds or
    // consequences, because the client's documents establish none — and the
    // schema has no column that would support one. See
    // lib/domain/meetings.ts.
    id: 'meetings',
    label: 'Meetings',
    icon: CalendarDays,
    items: [
      {
        href: ROUTES.meetings,
        label: 'Meetings Calendar',
        permission: 'meetings:view',
        phase: 24,
      },
      {
        href: `${ROUTES.meetings}?status=upcoming`,
        label: 'Upcoming Meetings',
        permission: 'meetings:view',
        phase: 24,
      },
      {
        href: `${ROUTES.meetings}?status=held`,
        label: 'Past Meetings',
        permission: 'meetings:view',
        phase: 24,
      },
      {
        href: ROUTES.newMeeting,
        label: 'Schedule Meeting',
        permission: 'meetings:view',
        requires: ['meetings:manage'],
        phase: 24,
      },
    ],
  },
  {
    // Phase 13 reorganised the register around the workflow, and its ten
    // stages are exactly the views this module needs — one query, ten `where`
    // clauses, so no two entries here can disagree about what "in arrears"
    // means.
    id: 'loans',
    label: 'Loan Management',
    icon: Banknote,
    items: [
      {
        href: ROUTES.loans,
        label: 'Loan Register',
        permission: 'loans:view',
        phase: 4,
      },
      {
        href: `${ROUTES.loans}/new`,
        label: 'New Loan Application',
        permission: 'loans:view',
        requires: ['loans:create'],
        phase: 4,
      },
      {
        href: `${ROUTES.loans}?stage=draft`,
        label: 'Draft Applications',
        permission: 'loans:view',
        phase: 13,
      },
      {
        href: `${ROUTES.loans}?stage=pending_approval`,
        label: 'Pending Approval',
        permission: 'loans:view',
        phase: 13,
      },
      {
        href: `${ROUTES.loans}?stage=approved`,
        label: 'Approved Loans',
        permission: 'loans:view',
        phase: 13,
      },
      {
        href: `${ROUTES.loans}?stage=awaiting_disbursement`,
        label: 'Awaiting Disbursement',
        permission: 'loans:view',
        phase: 13,
      },
      {
        href: `${ROUTES.loans}?stage=active`,
        label: 'Active Loans',
        permission: 'loans:view',
        phase: 13,
      },
      {
        href: `${ROUTES.loans}?stage=grace_period`,
        label: 'Grace Period',
        permission: 'loans:view',
        phase: 13,
      },
      {
        href: `${ROUTES.loans}?stage=arrears`,
        label: 'Arrears',
        permission: 'loans:view',
        phase: 13,
      },
      {
        href: `${ROUTES.loans}?stage=cleared`,
        label: 'Cleared Loans',
        permission: 'loans:view',
        phase: 13,
      },
      {
        // Two stages, two entries. The workflow distinguishes a decision that
        // went against the applicant from an application they withdrew, and
        // one row cannot point at both.
        href: `${ROUTES.loans}?stage=rejected`,
        label: 'Rejected',
        permission: 'loans:view',
        phase: 13,
      },
      {
        href: `${ROUTES.loans}?stage=withdrawn`,
        label: 'Cancelled',
        permission: 'loans:view',
        phase: 13,
      },
      {
        // The product breakdown is a monthly management read; the register's
        // own link to it is `prefetch={false}` for the same reason.
        href: `${ROUTES.loans}/by-product`,
        label: 'Loans by Product',
        permission: 'loans:view',
        phase: 13,
        prefetch: false,
      },
      {
        href: `${ROUTES.audit}?entity=loan`,
        label: 'Loan History',
        permission: 'audit:view',
        phase: 2,
      },
    ],
  },
  {
    id: 'collections',
    label: 'Collections',
    icon: Receipt,
    items: [
      {
        href: `${ROUTES.payments}/new`,
        label: 'Collect Payment',
        permission: 'payments:view',
        requires: ['payments:create'],
        phase: 6,
      },
      {
        href: ROUTES.payments,
        label: 'Payment History',
        permission: 'payments:view',
        phase: 6,
      },
      {
        // `period=today` resolves in the *business* timezone, which is why
        // this points at the report rather than at a hand-built date range on
        // the register.
        href: `${ROUTES.reports}/collections?period=today`,
        label: "Today's Collections",
        permission: 'reports:view_operational',
        requires: ['payments:view'],
        phase: 8,
      },
      {
        href: `${ROUTES.payments}?status=reversed`,
        label: 'Reversals',
        permission: 'payments:view',
        phase: 6,
      },
      {
        href: ROUTES.collectionSummary,
        label: 'Collection Summary',
        permission: 'payments:view',
        phase: 13,
      },
      // The summary reads the register once and sums it five ways, so these
      // are sections of one page rather than four more queries. The by-branch
      // slice belongs to Branch Network, which is the module a reader asking
      // a branch question opens.
      {
        href: `${ROUTES.collectionSummary}?section=method#by-method`,
        label: 'Collections by Payment Method',
        permission: 'payments:view',
        phase: 13,
      },
      {
        href: `${ROUTES.collectionSummary}?section=staff#by-staff`,
        label: 'Collections by Staff',
        permission: 'payments:view',
        phase: 13,
      },
      {
        href: `${ROUTES.collectionSummary}?section=product#by-product`,
        label: 'Collections by Loan Product',
        permission: 'payments:view',
        phase: 13,
      },
    ],
  },
  {
    // Phase 14. `/overdue` is the morning worklist a collections officer
    // opens standing up; `/recovery` is the hub above it, with five views in
    // the URL so the server fetches the one being read. Both are here,
    // because both answer "who is behind and what is being done about it".
    id: 'debt',
    label: 'Debt & Security',
    icon: ShieldAlert,
    items: [
      {
        href: ROUTES.overdue,
        label: 'Overdue Loans',
        permission: 'delinquency:view',
        phase: 7,
      },
      {
        href: ROUTES.recovery,
        label: 'Aging Buckets',
        permission: 'recovery:view',
        phase: 14,
        prefetch: false,
      },
      {
        href: `${ROUTES.recovery}?view=risk`,
        label: 'Risk Monitoring',
        permission: 'recovery:view',
        phase: 14,
        prefetch: false,
      },
      {
        href: `${ROUTES.recovery}?view=follow-ups`,
        label: 'Follow-Ups',
        permission: 'recovery:view',
        phase: 14,
        prefetch: false,
      },
      {
        href: `${ROUTES.recovery}?view=promises`,
        label: 'Promise to Pay',
        permission: 'recovery:view',
        phase: 14,
        prefetch: false,
      },
      {
        href: `${ROUTES.recovery}?view=security`,
        label: 'Collateral / Security',
        permission: 'recovery:view',
        phase: 14,
        prefetch: false,
      },
      {
        // The register — who stands for whom, for how much, and whether the
        // undertaking still binds. This is the one the brief means by "the
        // main Guarantors Register", and it belongs here: a guarantor is
        // security on a loan.
        href: ROUTES.guarantorRegister,
        label: 'Guarantors',
        permission: 'guarantors:view',
        phase: 14,
        prefetch: false,
      },
      {
        // The people records, where a new guarantor is captured. Distinct
        // from the register above, which is the undertakings.
        href: ROUTES.guarantors,
        label: 'Guarantor Directory',
        permission: 'guarantors:view',
        phase: 3,
      },
      {
        href: `${ROUTES.reports}/guarantors`,
        label: 'Guarantor Exposure',
        permission: 'reports:view_operational',
        requires: ['reports:view_financial', 'guarantors:view'],
        phase: 16,
        prefetch: false,
      },
      {
        // "Arrears Report", not "Arrears": Loan Management already carries
        // the arrears *stage* of the register, and two rows called the same
        // thing is a screen reader reading one name twice.
        href: `${ROUTES.reports}/arrears`,
        label: 'Arrears Report',
        permission: 'reports:view_operational',
        requires: ['delinquency:view'],
        phase: 8,
        prefetch: false,
      },
      {
        href: `${ROUTES.reports}/penalties`,
        label: 'Penalties',
        permission: 'reports:view_operational',
        requires: ['reports:view_financial', 'penalties:view'],
        phase: 8,
        prefetch: false,
      },
      {
        // The recovery file: every call, visit, message, notice and promise
        // recorded against a loan, in the order it happened.
        href: `${ROUTES.reports}/recovery`,
        label: 'Recovery Notes',
        permission: 'reports:view_operational',
        requires: ['recovery:view'],
        phase: 16,
        prefetch: false,
      },
    ],
  },
  {
    id: 'finance',
    label: 'Finance',
    icon: Landmark,
    items: [
      {
        href: ROUTES.finance,
        label: 'Cash Position',
        permission: 'ledger:view',
        phase: 11,
      },
      {
        href: ROUTES.transfers,
        label: 'Transfers',
        permission: 'transfers:view',
        phase: 11,
      },
      {
        href: ROUTES.expenses,
        label: 'Expenses',
        permission: 'expenses:view',
        phase: 11,
      },
      {
        href: ROUTES.otherIncome,
        label: 'Other Income',
        permission: 'income:view',
        phase: 11,
      },
      {
        href: ROUTES.reconciliation,
        label: 'Reconciliation',
        permission: 'reconciliation:view',
        phase: 11,
      },
      {
        href: ROUTES.ledger,
        label: 'General Ledger',
        permission: 'ledger:view',
        phase: 11,
      },
      {
        // Phase 18. The statement over the ledger, read from
        // `public.trial_balance`.
        //
        // `Account Activity` and `Liquidity Position` are deliberately not
        // rows of their own: account activity *is* the general ledger
        // narrowed by `?account=`, reached from the account chips on that
        // page, and the liquidity position is the total on the cash position
        // cards. A third and fourth row pointing at those two screens would
        // be the same figures under two more names.
        href: ROUTES.trialBalance,
        label: 'Trial Balance',
        permission: 'ledger:view',
        phase: 18,
      },
    ],
  },
  {
    /*
      AGENCY — three branches, because the business has three.

      The flat fourteen-entry list this replaces made a counter screen, a
      provider register and a Mobile Money dashboard siblings, which told a
      reader that recording a customer's deposit, configuring a bank and
      reading a network's position are the same kind of act. They are not,
      and the client's confirmed requirements say so: Agent Banking and
      Mobile Money are separate operational modules, and the consolidated
      reports are a third thing that reads across both.

      Every destination below already existed or is added by this redesign,
      and each one leads to a page that renders something. Several are
      filtered views of a screen that already reads the filter — the
      reporting hub's seven sections, the account register narrowed to one
      bank — because, as the note on `NavItem` says, a label does not earn a
      route.

      The per-bank, per-provider and per-line branches are **not** here. They
      are built from the database by `agencyNavGroups()`, because which banks
      are configured and which lines are registered is business data. Nothing
      in this file names STANBIC, MTN or Airtel.
    */
    id: 'agency',
    label: 'Agency',
    icon: Network,
    // No direct entries: every Agency destination belongs to one of the three
    // branches, and a loose row above them would belong to none of them.
    items: [],
    groups: [
      {
        id: 'agency-banking',
        label: 'Agent Banking',
        icon: Landmark,
        items: [
          {
            href: ROUTES.agencyBanking,
            label: 'Overview',
            permission: 'agency:reports',
            phase: 4,
          },
          {
            // The counter. Shared with Mobile Money deliberately: a deposit
            // is recorded by one engine whatever the provider is, and a
            // second counter screen would be a second posting path.
            href: ROUTES.agencyRecord,
            label: 'Record transaction',
            permission: 'agency:write',
            phase: 4,
          },
          {
            href: ROUTES.agencyPending,
            label: 'Pending verification',
            permission: 'agency:reports',
            phase: 4,
          },
          {
            href: ROUTES.agencyHistory,
            label: 'Transaction history',
            permission: 'agency:reports',
            phase: 4,
          },
          {
            href: ROUTES.agencyReplenish,
            label: 'Float top-ups',
            permission: 'agency:settlements',
            phase: 4,
          },
          {
            href: ROUTES.agencyTransfers,
            label: 'Account transfers',
            permission: 'agency:float_trade',
            phase: 4,
          },
          {
            href: ROUTES.agencyCashBanking,
            label: 'Cash banking',
            permission: 'agency:write',
            phase: 4,
          },
          {
            href: ROUTES.agencyCommission,
            label: 'Commissions',
            permission: 'agency:reports',
            phase: 4,
          },
          {
            href: ROUTES.agencyPayables,
            label: 'Settlements',
            permission: 'agency:reports',
            phase: 4,
          },
          {
            href: ROUTES.agencyCashCount,
            label: 'Cash reconciliation',
            permission: 'agency:reconcile',
            phase: 4,
          },
          {
            href: ROUTES.agencyFloatCount,
            label: 'Float reconciliation',
            permission: 'agency:reconcile',
            phase: 4,
          },
          {
            // The reporting hub, narrowed to the banking providers. The hub
            // reads `scope`, so this is a view of a screen rather than a
            // second report.
            href: `${ROUTES.agencyReports}?scope=banking`,
            label: 'Banking reports',
            permission: 'agency:reports',
            phase: 4,
            prefetch: false,
          },
        ],
        groups: [
          {
            id: 'agency-banking-banks',
            label: 'Banks & Agent Accounts',
            items: [
              {
                href: ROUTES.agencyBankingAccounts,
                label: 'All banks & accounts',
                permission: 'agency:reports',
                phase: 4,
              },
              {
                // Registering a bank is configuration, not counter work, and
                // it is the Owner's: `agency:providers`. It sits here because
                // this is where a reader discovers there is no bank yet.
                href: ROUTES.agencyProviders,
                label: 'Register a bank',
                permission: 'agency:providers',
                phase: 4,
              },
              {
                href: ROUTES.agencyLines,
                label: 'Register an agent account',
                permission: 'agency:providers',
                phase: 4,
              },
            ],
            emptyLabel: 'No bank is configured yet',
          },
        ],
      },
      {
        id: 'agency-money',
        label: 'Mobile Money',
        icon: Smartphone,
        items: [
          {
            href: ROUTES.agencyMoney,
            label: 'Overview',
            permission: 'agency:reports',
            phase: 4,
          },
        ],
        // MTN and Airtel are built from the provider register, below.
        emptyLabel: 'No Mobile Money provider is configured yet',
      },
      {
        id: 'agency-consolidated',
        label: 'Consolidated Agency Reports',
        icon: ChartColumn,
        items: [
          {
            href: ROUTES.agencyReports,
            label: 'Overview',
            permission: 'agency:reports',
            phase: 4,
          },
          {
            href: `${ROUTES.agencyReports}?section=transactions`,
            label: 'Transaction reports',
            permission: 'agency:reports',
            phase: 4,
            prefetch: false,
          },
          {
            href: `${ROUTES.agencyReports}?section=cash-float`,
            label: 'Cash & float reports',
            permission: 'agency:reports',
            phase: 4,
            prefetch: false,
          },
          {
            href: `${ROUTES.agencyReports}?section=commission`,
            label: 'Commission reports',
            permission: 'agency:reports',
            phase: 4,
            prefetch: false,
          },
          {
            href: `${ROUTES.agencyReports}?section=settlements`,
            label: 'Settlement reports',
            permission: 'agency:reports',
            phase: 4,
            prefetch: false,
          },
          {
            href: `${ROUTES.agencyReports}?section=reconciliation`,
            label: 'Reconciliation reports',
            permission: 'agency:reports',
            phase: 4,
            prefetch: false,
          },
          {
            href: `${ROUTES.agencyReports}?section=performance`,
            label: 'Agent performance',
            permission: 'agency:reports',
            phase: 4,
            prefetch: false,
          },
          {
            href: ROUTES.agencyExceptions,
            label: 'Audit & exception reports',
            permission: 'agency:reports',
            phase: 4,
          },
          {
            href: `${ROUTES.agencyReports}?section=export`,
            label: 'Export centre',
            permission: 'agency:reports',
            phase: 4,
            prefetch: false,
          },
        ],
      },
    ],
  },
  {
    // Phase 16 declared every report once, in `lib/reports/registry.ts`, and
    // grouped them four ways. Those groups are this module's entries: the
    // Centre stays the place a report is chosen, filtered and exported from,
    // and ten report definitions in a rail would be the contents of a module
    // inside its own menu.
    id: 'reports',
    label: 'Reports',
    icon: ChartColumn,
    items: [
      {
        href: ROUTES.reports,
        label: 'Reports Centre',
        permission: 'reports:view_operational',
        phase: 8,
      },
      {
        href: `${ROUTES.reports}?group=money-in`,
        label: 'Collections Reports',
        permission: 'reports:view_operational',
        requires: ['payments:view'],
        phase: 16,
      },
      {
        href: `${ROUTES.reports}?group=behind`,
        label: 'Arrears & Risk Reports',
        permission: 'reports:view_operational',
        requires: ['delinquency:view'],
        phase: 16,
      },
      {
        href: `${ROUTES.reports}?group=book`,
        label: 'Loan & Client Reports',
        permission: 'reports:view_operational',
        requires: ['clients:view'],
        phase: 16,
      },
      {
        href: `${ROUTES.reports}?group=security`,
        label: 'Security & Guarantee Reports',
        permission: 'reports:view_operational',
        requires: ['reports:view_financial', 'guarantors:view'],
        phase: 16,
      },
    ],
  },
  {
    // A cross-cutting module, and openly so. Phase 9 has no standalone
    // branch screen: a branch is a dimension of the cash position, of the
    // collection summary, of the aging report and of the portfolio at risk,
    // and it is configured on the settings page. So this module is four deep
    // links into the places a branch question is actually answered, rather
    // than four new screens that would each re-derive somebody else's
    // figures.
    id: 'branches',
    label: 'Branch Network',
    icon: Network,
    items: [
      {
        href: `${ROUTES.settings}?section=branches#branches-heading`,
        label: 'Branches',
        permission: 'settings:view',
        phase: 12,
      },
      {
        href: `${ROUTES.finance}?section=cash#cash-position-heading`,
        label: 'Branch Cash Position',
        permission: 'ledger:view',
        phase: 11,
      },
      {
        href: `${ROUTES.collectionSummary}?section=branch#by-branch`,
        label: 'Branch Performance',
        permission: 'payments:view',
        phase: 13,
      },
      {
        // The aging report carries a branch column and a branch filter, and
        // is the per-branch view of the live book.
        href: `${ROUTES.reports}/aging`,
        label: 'Branch Portfolio',
        permission: 'reports:view_operational',
        requires: ['reports:view_financial', 'delinquency:view'],
        phase: 16,
        prefetch: false,
      },
    ],
  },
  {
    id: 'administration',
    label: 'Administration',
    icon: Settings,
    items: [
      {
        href: ROUTES.users,
        label: 'Users',
        permission: 'users:view',
        phase: 2,
      },
      {
        // Beside Settings rather than inside it: a Secretary/Treasurer holds
        // `products:view` and no `settings:view` at all.
        href: ROUTES.loanProducts,
        label: 'Loan Products',
        permission: 'products:view',
        phase: 12,
      },
      // The settings subjects are sections of one page. Each entry carries
      // the section twice: as `?section=`, which is what the rail highlights
      // on and what opens the page's chip row at the right section, and as a
      // fragment, which moves the browser with no JavaScript at all.
      // "Branches" is in Branch Network, where a reader looks for it.
      {
        href: ROUTES.settings,
        label: 'Company Settings',
        permission: 'settings:view',
        phase: 3,
      },
      {
        href: `${ROUTES.settings}?section=lending#rules-heading`,
        label: 'Lending Rules',
        permission: 'settings:view',
        phase: 3,
      },
      {
        href: `${ROUTES.settings}?section=guarantors#guarantors-heading`,
        label: 'Guarantor Rules',
        permission: 'settings:view',
        phase: 3,
      },
      {
        href: `${ROUTES.settings}?section=finance#finance-heading`,
        label: 'Finance Settings',
        permission: 'settings:view',
        phase: 3,
      },
      {
        href: `${ROUTES.settings}?section=references#references-heading`,
        label: 'Reference Numbers',
        permission: 'settings:view',
        phase: 3,
      },
      {
        href: ROUTES.audit,
        label: 'Audit Trail',
        permission: 'audit:view',
        phase: 2,
      },
      {
        href: ROUTES.account,
        label: 'My Account',
        permission: 'account:view',
        phase: 2,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Walking the tree
// ---------------------------------------------------------------------------

/**
 * Every destination inside a group, including its nested groups'.
 *
 * Depth-first and order-preserving, so "the entries of this branch" reads the
 * same way the rail renders it.
 */
export function groupItems(group: NavGroup): readonly NavItem[] {
  return [...group.items, ...(group.groups ?? []).flatMap((child) => groupItems(child))];
}

/** Every destination in a module: its own entries, then its branches'. */
export function moduleItems(module: NavModule): readonly NavItem[] {
  return [
    ...module.items,
    ...(module.groups ?? []).flatMap((group) => groupItems(group)),
  ];
}

/**
 * Every staff destination, flat: the two pinned rows plus every module.
 *
 * Reads through the groups as well as the items, which is the whole reason
 * `moduleItems` exists. Before the rail grew a third level this was
 * `module.items` alone; leaving it that way would have dropped every Agency
 * destination out of the navigation parity test — the test that asserts a
 * visible link and a guarded route cannot disagree — and it would have done
 * so silently, by passing.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  DASHBOARD_ITEM,
  ...NAV_MODULES.flatMap((module) => moduleItems(module)),
  NOTIFICATIONS_ITEM,
];

/** Borrower navigation. Deliberately tiny, and structurally separate. */
export const PORTAL_NAV_ITEMS: readonly NavItem[] = [
  {
    href: ROUTES.portal,
    label: 'My loans',
    shortLabel: 'Loans',
    icon: Banknote,
    permission: 'portal:view',
    phase: 6,
    bottomBarRank: 1,
  },
  {
    href: ROUTES.account,
    label: 'My account',
    shortLabel: 'Me',
    icon: UserCircle,
    permission: 'account:view',
    phase: 2,
    bottomBarRank: 2,
  },
];

// ---------------------------------------------------------------------------
// Splitting an href
// ---------------------------------------------------------------------------

/** The path part of a nav href, without its query string or fragment. */
export function navPath(href: string): string {
  const cut = href.search(/[?#]/);
  return cut === -1 ? href : href.slice(0, cut);
}

/**
 * The query parameters a nav href pins, as pairs.
 *
 * Pairs rather than a `URLSearchParams`, because what every caller wants is
 * "how many does it pin" and "do they all match", and both are one line over
 * an array.
 */
export function navQuery(href: string): readonly (readonly [string, string])[] {
  const start = href.indexOf('?');
  if (start === -1) return [];
  const end = href.indexOf('#', start);
  const query = href.slice(start + 1, end === -1 ? undefined : end);
  return [...new URLSearchParams(query).entries()];
}

// ---------------------------------------------------------------------------
// Capability filtering
// ---------------------------------------------------------------------------

/**
 * May this set of capabilities reach this destination?
 *
 * The route's own capability *and* anything the page guards on top of it. A
 * Secretary/Treasurer holds `reports:view_operational`, so the reporting
 * prefix is open to them, but the late-payment charges report guards
 * `reports:view_financial` — an entry for it would be an entry that refuses
 * them.
 */
export function canReachNavItem(
  item: NavItem,
  permissions: readonly Permission[],
): boolean {
  if (!permissions.includes(item.permission)) return false;
  return (item.requires ?? []).every((permission) => permissions.includes(permission));
}

/**
 * The entries a given set of capabilities may see.
 *
 * Exported for direct testing: the filtering rule is a visible part of the
 * authorization model and is asserted independently of any component.
 */
export function visibleNavItems(
  items: readonly NavItem[],
  permissions: readonly Permission[],
): readonly NavItem[] {
  return items.filter((item) => canReachNavItem(item, permissions));
}

/**
 * One group, with only the entries and branches this person may reach.
 *
 * `null` for a group a reader should not meet, because a header that opens
 * onto nothing is worse than no header.
 *
 * ## Why "empty" is two different things
 *
 * A branch can end up with nothing in it for two unrelated reasons, and they
 * call for opposite answers:
 *
 *   * **no data yet** — a configured bank with no agent account registered
 *     against it, a Mobile Money network with no line. The reader may see the
 *     branch; there is simply nothing in it. That is worth saying, which is
 *     what `emptyLabel` is for, and omitting the branch would make a bank the
 *     Owner has configured look identical to one nobody set up.
 *
 *   * **not yours** — every entry the branch declared was filtered out by the
 *     capability check. Showing an empty state here would tell a borrower
 *     that Mobile Money exists and is empty, which is both untrue and none of
 *     their business.
 *
 * The two are told apart by what the group *declared*: a group that declared
 * nothing of its own had nothing to filter, so an empty result means no data.
 * A group whose declared entries are all gone was filtered, so it is dropped
 * whatever `emptyLabel` says.
 *
 * Getting this wrong is not theoretical — the first version kept any group
 * carrying an `emptyLabel`, and the navigation test caught the Agency module
 * surviving for a borrower who holds no agency capability at all.
 */
export function visibleNavGroup(
  group: NavGroup,
  permissions: readonly Permission[],
): NavGroup | null {
  const items = visibleNavItems(group.items, permissions);
  const groups = (group.groups ?? [])
    .map((child) => visibleNavGroup(child, permissions))
    .filter((child): child is NavGroup => child !== null);

  if (items.length > 0 || groups.length > 0) return { ...group, items, groups };

  const declaredNothing = group.items.length === 0 && (group.groups?.length ?? 0) === 0;
  if (declaredNothing && group.emptyLabel !== undefined) {
    return { ...group, items, groups };
  }

  return null;
}

/**
 * The modules this person may see, each with the entries and branches they
 * may reach.
 *
 * A module that filtered down to nothing is dropped, so a Secretary never
 * meets an "Administration" header that opens onto an empty list. A module
 * whose own `items` are empty but which still has a branch survives — the
 * Agency module is exactly that, and dropping it would hide the whole module
 * from everybody.
 */
export function visibleNavModules(
  permissions: readonly Permission[],
): readonly NavModule[] {
  return NAV_MODULES.map((module) => ({
    ...module,
    items: visibleNavItems(module.items, permissions),
    groups: (module.groups ?? [])
      .map((group) => visibleNavGroup(group, permissions))
      .filter((group): group is NavGroup => group !== null),
  })).filter((module) => module.items.length > 0 || (module.groups?.length ?? 0) > 0);
}

// ---------------------------------------------------------------------------
// Which entry is the page being viewed
// ---------------------------------------------------------------------------

/**
 * Could this entry be the page currently open?
 *
 * Two conditions. The path has to match — exactly, or as the parent of the
 * open subtree, so a loan's detail page keeps the loan register lit. And
 * every parameter the entry pins has to be present and equal in the URL, so
 * `/loans?stage=draft` is not lit by a visit to `/loans`.
 *
 * The dashboard lives at `/`, which prefixes everything, so it matches
 * exactly and nothing else.
 */
export function isNavItemActive(
  href: string,
  pathname: string,
  params?: URLSearchParams | null,
): boolean {
  const path = navPath(href);

  const pathMatches =
    path === ROUTES.dashboard
      ? pathname === ROUTES.dashboard
      : pathname === path || pathname.startsWith(`${path}/`);

  if (!pathMatches) return false;

  return navQuery(href).every(([key, value]) => params?.get(key) === value);
}

/**
 * The one entry that is the page being viewed, or `null`.
 *
 * Several entries can match at once — `/loans`, `/loans?stage=active` and
 * `/loans/{id}` all live under the same prefix — and a rail that lit two of
 * them would be telling the reader they are in two places. The most specific
 * match wins: the longest path first, then the most pinned parameters.
 */
export function currentNavItem(
  items: readonly NavItem[],
  pathname: string,
  params?: URLSearchParams | null,
): NavItem | null {
  const matches = items.filter((item) => isNavItemActive(item.href, pathname, params));
  if (matches.length === 0) return null;

  return matches.reduce((best, item) => {
    const bestPath = navPath(best.href).length;
    const itemPath = navPath(item.href).length;
    if (itemPath !== bestPath) return itemPath > bestPath ? item : best;
    return navQuery(item.href).length > navQuery(best.href).length ? item : best;
  });
}

/**
 * The module holding the page being viewed, or `null` for the two pinned
 * rows.
 *
 * What the rail auto-expands on arrival: navigating to Expenses opens
 * Finance, and opening a promise register opens Debt & Security, without the
 * reader hunting for where they are.
 */
export function currentNavModuleId(
  modules: readonly NavModule[],
  pathname: string,
  params?: URLSearchParams | null,
): NavModuleId | null {
  const current = currentNavItem(
    modules.flatMap((module) => moduleItems(module)),
    pathname,
    params,
  );
  if (current === null) return null;

  return (
    modules.find((module) =>
      moduleItems(module).some((item) => item.href === current.href),
    )?.id ?? null
  );
}

// ---------------------------------------------------------------------------
// The borrower portal's bottom bar
// ---------------------------------------------------------------------------

/**
 * The entries a bottom bar shows, and the ones behind "More".
 *
 * The bar takes the four highest-ranked destinations this person can reach,
 * in rank order; everything else they can reach goes to the overflow. Both
 * lists come from the same capability filter, so a destination cannot appear
 * in one and be missing from the other.
 *
 * When the overflow would be empty — the borrower portal, which has two
 * entries — the bar takes everything and no "More" button is rendered. A
 * button that opens a list of nothing is worse than no button.
 */
export function splitForBottomBar(
  items: readonly NavItem[],
  permissions: readonly Permission[],
): { readonly bar: readonly NavItem[]; readonly overflow: readonly NavItem[] } {
  const visible = visibleNavItems(items, permissions);

  const ranked = visible
    .filter((item) => item.bottomBarRank !== undefined)
    .toSorted((a, b) => (a.bottomBarRank ?? 0) - (b.bottomBarRank ?? 0));

  const rest = visible.filter((item) => !ranked.includes(item));

  if (visible.length <= BOTTOM_BAR_SLOTS + 1) {
    return { bar: visible, overflow: [] };
  }

  const bar = ranked.slice(0, BOTTOM_BAR_SLOTS);
  const overflow = [...ranked.slice(BOTTOM_BAR_SLOTS), ...rest];

  return { bar, overflow };
}

// ---------------------------------------------------------------------------
// Which branches are open
// ---------------------------------------------------------------------------

/**
 * The ids of every group on the path from a module down to the entry being
 * viewed.
 *
 * What the rail opens by itself on arrival. Opening a line's page should
 * reveal the line under its provider under Mobile Money — three headers — and
 * a reader who had to open three branches to find where they already are is
 * being asked to navigate to their own location.
 *
 * Returns the ancestors rather than just the innermost group, because a
 * branch whose parent is closed is not visible however open it claims to be.
 */
export function activeNavGroupIds(
  module: NavModule,
  current: NavItem | null,
): readonly string[] {
  if (current === null) return [];

  const walk = (groups: readonly NavGroup[]): readonly string[] => {
    for (const group of groups) {
      if (group.items.some((item) => item.href === current.href)) return [group.id];
      const deeper = walk(group.groups ?? []);
      if (deeper.length > 0) return [group.id, ...deeper];
    }
    return [];
  };

  return walk(module.groups ?? []);
}

// ---------------------------------------------------------------------------
// The Agency branch's data-driven groups
// ---------------------------------------------------------------------------

/**
 * One agent account or agent line, as the rail needs it.
 *
 * Plain serialisable data, resolved on the server and passed through the
 * shell: no React component, no Lucide icon, nothing that cannot cross the
 * Server/Client boundary. The masked number is the only form of the MSISDN
 * that reaches a screen.
 */
export interface AgencyNavAccount {
  readonly id: string;
  readonly label: string;
  readonly status: 'active' | 'suspended' | 'closed';
}

/** One configured provider, with the accounts registered against it. */
export interface AgencyNavProvider {
  readonly code: string;
  readonly name: string;
  readonly accounts: readonly AgencyNavAccount[];
}

/**
 * The banks and the Mobile Money networks the rail should show.
 *
 * Two lists rather than one with a category on each entry, because the two
 * modules render them differently: a bank's accounts hang off the shared
 * "Banks & Agent Accounts" branch, while each Mobile Money network is a
 * branch of its own with its own operations beneath it.
 */
export interface AgencyNavData {
  readonly banks: readonly AgencyNavProvider[];
  readonly mobileMoney: readonly AgencyNavProvider[];
}

/** Nothing configured, or nothing readable. The rail still renders. */
export const EMPTY_AGENCY_NAV: AgencyNavData = { banks: [], mobileMoney: [] };

/**
 * One account's entry: its own detail page.
 *
 * A suspended or closed account says so in the label. The alternative is a
 * rail where a line that takes no new business looks exactly like one that
 * does, and the first time anybody finds out is when the counter refuses a
 * transaction on it. `NavItem` carries no status field and should not grow
 * one for this: the fact belongs to the label because it is part of what the
 * destination *is*.
 *
 * `agency:reports` because that is what the detail route guards, and
 * `prefetch: false` because the page reads a per-account aggregate — opening a
 * provider with eight lines should not fire eight of them.
 */
function accountItem(account: AgencyNavAccount): NavItem {
  const suffix =
    account.status === 'suspended'
      ? ' — suspended'
      : account.status === 'closed'
        ? ' — closed'
        : '';

  return {
    href: `${ROUTES.agencyAccounts}/${account.id}`,
    label: `${account.label}${suffix}`,
    permission: 'agency:reports',
    phase: 4,
    prefetch: false,
  };
}

/**
 * A provider's own branch under Mobile Money: its operations, then its lines.
 *
 * Every operation is a view of a screen that already exists and already reads
 * the filter, which is why there is one provider screen rather than an MTN one
 * and an Airtel one. The provider code is in the href, so this function knows
 * nothing about which networks the business uses.
 */
function mobileMoneyProviderGroup(provider: AgencyNavProvider): NavGroup {
  const base = `${ROUTES.agencyMoney}/${provider.code}`;

  return {
    id: `agency-money-${provider.code}`,
    label: provider.name,
    items: [
      { href: base, label: 'Dashboard', permission: 'agency:reports', phase: 4 },
      {
        href: `${ROUTES.agencyHistory}?provider=${provider.code}`,
        label: 'Transactions',
        permission: 'agency:reports',
        phase: 4,
        prefetch: false,
      },
      {
        href: `${base}#float-trades`,
        label: 'Float management',
        permission: 'agency:reports',
        phase: 4,
        prefetch: false,
      },
      {
        href: `${base}/commission`,
        label: 'Commissions',
        permission: 'agency:reports',
        phase: 4,
        prefetch: false,
      },
      {
        href: `${base}/statements`,
        label: 'Reconciliation',
        permission: 'agency:reports',
        phase: 4,
        prefetch: false,
      },
      {
        href: `${ROUTES.agencyReports}?provider=${provider.code}`,
        label: `${provider.name} reports`,
        permission: 'agency:reports',
        phase: 4,
        prefetch: false,
      },
    ],
    groups: [
      {
        id: `agency-money-${provider.code}-lines`,
        label: 'Agent lines',
        items: provider.accounts.map(accountItem),
        // Not "no lines": a reader who sees this needs to know the provider is
        // configured and the lines are not, which is a different problem from
        // a provider nobody has set up.
        emptyLabel: 'No agent line registered yet',
      },
    ],
  };
}

/** A bank's branch: its registered agent accounts, and each account's page. */
function bankGroup(bank: AgencyNavProvider): NavGroup {
  return {
    id: `agency-bank-${bank.code}`,
    label: bank.name,
    items: [
      {
        // The register, narrowed to this bank. A filtered view of a screen
        // that reads the filter, not a route per bank.
        href: `${ROUTES.agencyBankingAccounts}?provider=${bank.code}`,
        label: 'Registered agent accounts',
        permission: 'agency:reports',
        phase: 4,
        prefetch: false,
      },
      ...bank.accounts.map(accountItem),
    ],
    emptyLabel: 'No agent account registered yet',
  };
}

/**
 * The Agency module, with its data-driven branches grafted on.
 *
 * Pure: it takes the static tree and the data and returns a new tree, so the
 * static declaration stays the single statement of what the module offers and
 * this stays the single statement of how the data hangs off it. The rail
 * calls it after the capability filter, so an account a reader may not see
 * never reaches a group.
 *
 * A provider with no accounts still gets its branch — with an empty state
 * inside. That is the requirement's "show a meaningful empty state and a
 * permitted registration action" rather than silently omitting a bank the
 * Owner has configured and is waiting to use.
 */
export function withAgencyNavData(
  modules: readonly NavModule[],
  data: AgencyNavData,
): readonly NavModule[] {
  return modules.map((module) => {
    if (module.id !== 'agency') return module;

    return {
      ...module,
      groups: (module.groups ?? []).map((group) => {
        if (group.id === 'agency-banking') {
          return {
            ...group,
            groups: (group.groups ?? []).map((child) =>
              child.id === 'agency-banking-banks'
                ? { ...child, groups: data.banks.map(bankGroup) }
                : child,
            ),
          };
        }
        if (group.id === 'agency-money') {
          return { ...group, groups: data.mobileMoney.map(mobileMoneyProviderGroup) };
        }
        return group;
      }),
    };
  });
}
