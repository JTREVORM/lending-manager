import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ClientMembershipPanel } from '@/components/membership/client-membership-panel';
import { MembershipHistory } from '@/components/membership/membership-history';
import { MembershipPolicyPanel } from '@/components/membership/membership-policy-panel';
import { MembershipRegister } from '@/components/membership/membership-register';
import { MembershipStatusBadge } from '@/components/membership/membership-status-badge';
import { NAV_MODULES, visibleNavModules } from '@/components/layout/nav-items';
import { ROUTES } from '@/config/app';
import { permissionForPath } from '@/lib/auth/routing';
import { ROLE_PERMISSIONS } from '@/lib/permissions';
import {
  MEMBERSHIP_STATUSES,
  MEMBERSHIP_STATUS_LABELS,
  UNDECIDED_POLICY_RULES,
} from '@/lib/domain/membership';
import { toUgx } from '@/lib/domain/money';
import { toBps } from '@/lib/domain/rate';
import type {
  MembershipPage,
  MembershipPolicy,
  MembershipStatusEvent,
  MembershipSummary,
} from '@/lib/data/membership';

/**
 * The Polytos Phase 1 membership screens.
 *
 * Browser-level layout verification is the Playwright suite's job. What these
 * assert is the part that breaks silently: the structural choices that keep a
 * register usable at 320px, the accessibility wiring that is invisible when
 * it is wrong, and — the one specific to this phase — that the screens do not
 * offer a control for a workflow that does not exist, and do not render an
 * undecided policy rule as though it were a decided one.
 */
vi.mock('next/navigation', () => ({
  usePathname: () => '/membership',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const MEMBER: MembershipSummary = {
  id: 'b7d1a2c3-0000-4000-8000-000000000001',
  membershipNumber: 'MB260001',
  clientId: 'b7d1a2c3-0000-4000-8000-0000000000c1',
  clientNumber: 'CL26001',
  // A deliberately long three-part Ugandan name: the value that used to wrap
  // and clip in every register before the shared table layer.
  fullName: 'Nakabugo Ssemakula Nabukeera-Kiwanuka',
  phone: '+256772110015',
  villageArea: 'Kyanja Ring Road',
  district: 'Kampala',
  branchName: 'Head Office',
  status: 'active',
  appliedOn: '2026-03-02',
  activatedOn: '2026-03-09',
  endedOn: null,
  policyVersion: '1.0',
};

const PAGE: MembershipPage = { memberships: [MEMBER], page: 1, hasMore: false };
const EMPTY_PAGE: MembershipPage = { memberships: [], page: 1, hasMore: false };

/** The seeded version: in force, approved, and still eight rules short. */
const DRAFT_POLICY: MembershipPolicy = {
  id: 'b7d1a2c3-0000-4000-8000-0000000000p1',
  version: '1.0',
  title: 'Polytos membership programme — proposed terms',
  effectiveFrom: '2026-11-01',
  status: 'draft',

  registrationFee: toUgx(5_000),
  monthlySavingsMinimum: toUgx(50_000),
  savingsQualifyingMonths: 6,

  memberLoanInterestRateBps: toBps(500),
  memberLoanMaxTermMonths: 5,
  memberLoanWeeklyCadenceMaxMonths: 2,
  nonMemberLoanMaxTermMonths: 3,

  medicalBenefitRateBps: toBps(500),
  medicalBenefitMinAdmissionDays: 1,
  familyCondolenceBenefit: toUgx(100_000),
  memberBereavementBenefit: toUgx(200_000),

  interestBasis: null,
  interestMethod: null,
  savingsToLoanMultiplierBps: null,
  qualifyingMonthsConsecutive: null,
  savingsWithdrawalWithActiveLoan: null,
  profitDistributionBasis: null,
  medicalBenefitAnnualCap: null,
  medicalBenefitClaimsPerYear: null,
  benefitWaitingPeriodDays: null,

  approvedAt: null,
  approvedByLabel: null,
  approvalReference: null,
  // A draft opens nothing at all, which is what the five say here. They are
  // the database's own generated columns, so a fixture states them rather
  // than deriving them — deriving them would test the fixture.
  isEnrolmentEnabled: false,
  isSavingsEnabled: false,
  isMemberLendingEnabled: false,
  isBenefitsEnabled: false,
  isProfitSharingEnabled: false,
  isFinanciallyEnabled: false,
  notes: null,
};

const DECIDED_POLICY: MembershipPolicy = {
  ...DRAFT_POLICY,
  status: 'active',
  interestBasis: 'per_month',
  interestMethod: 'flat',
  savingsToLoanMultiplierBps: toBps(20_000),
  qualifyingMonthsConsecutive: true,
  savingsWithdrawalWithActiveLoan: 'blocked',
  profitDistributionBasis: 'pro_rata_savings',
  medicalBenefitAnnualCap: toUgx(500_000),
  medicalBenefitClaimsPerYear: 2,
  benefitWaitingPeriodDays: 90,
  approvedAt: '2026-10-01T09:00:00.000Z',
  approvedByLabel: 'Trevor Mwesigwa',
  approvalReference: 'Board minute 2026/04',
  isEnrolmentEnabled: true,
  isSavingsEnabled: true,
  isMemberLendingEnabled: true,
  isBenefitsEnabled: true,
  isProfitSharingEnabled: true,
  isFinanciallyEnabled: true,
};

/**
 * Approved and in force, with only the savings and lending rules settled.
 *
 * The case the single switch could not express: a counter may take a
 * registration fee and monthly savings while nobody has decided the medical
 * cap or the profit formula.
 */
const PARTLY_DECIDED_POLICY: MembershipPolicy = {
  ...DRAFT_POLICY,
  status: 'active',
  interestBasis: 'per_month',
  interestMethod: 'flat',
  savingsToLoanMultiplierBps: toBps(20_000),
  qualifyingMonthsConsecutive: true,
  savingsWithdrawalWithActiveLoan: 'blocked',
  approvedAt: '2026-10-01T09:00:00.000Z',
  approvedByLabel: 'Trevor Mwesigwa',
  isEnrolmentEnabled: true,
  isSavingsEnabled: true,
  isMemberLendingEnabled: true,
  isBenefitsEnabled: false,
  isProfitSharingEnabled: false,
  isFinanciallyEnabled: false,
};

const HISTORY: readonly MembershipStatusEvent[] = [
  {
    id: 1,
    fromStatus: null,
    toStatus: 'pending',
    reason: null,
    effectiveOn: '2026-03-02',
    changedByLabel: 'Trevor Mwesigwa',
    occurredAt: '2026-03-02T08:00:00.000Z',
  },
  {
    id: 2,
    fromStatus: 'pending',
    toStatus: 'active',
    reason: null,
    effectiveOn: '2026-03-09',
    changedByLabel: 'Trevor Mwesigwa',
    occurredAt: '2026-03-09T08:00:00.000Z',
  },
];

// ===========================================================================
describe('the membership register', () => {
  it('names the table, so a screen reader arriving at it knows what it is', () => {
    render(<MembershipRegister page={PAGE} filter={{ query: '', status: '' }} />);

    expect(
      screen.getByRole('table', { name: /membership register/i }),
    ).toBeInTheDocument();
  });

  it('renders a long member name in full, beside the number that identifies them', () => {
    render(<MembershipRegister page={PAGE} filter={{ query: '', status: '' }} />);

    // Twice: once in the phone card, once in the table. Both must carry it
    // whole — a clipped name on a membership register is a member nobody can
    // find.
    const names = screen.getAllByText('Nakabugo Ssemakula Nabukeera-Kiwanuka');
    expect(names.length).toBeGreaterThanOrEqual(2);

    expect(screen.getAllByText('MB260001').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('CL26001').length).toBeGreaterThanOrEqual(1);
  });

  it('offers every status as a filter, labelled in words', () => {
    render(<MembershipRegister page={PAGE} filter={{ query: '', status: '' }} />);

    const select = screen.getByLabelText('Status');

    for (const status of MEMBERSHIP_STATUSES) {
      expect(
        within(select).getByRole('option', { name: MEMBERSHIP_STATUS_LABELS[status] }),
      ).toBeInTheDocument();
    }
  });

  it('counts what it is showing without claiming a total it was not given', () => {
    render(<MembershipRegister page={PAGE} filter={{ query: '', status: '' }} />);

    expect(screen.getByText(/1 membership on this page/i)).toBeInTheDocument();
  });

  it('tells an empty register why it is empty, and offers no action', () => {
    render(<MembershipRegister page={EMPTY_PAGE} filter={{ query: '', status: '' }} />);

    expect(screen.getByText(/No members have been enrolled yet/i)).toBeInTheDocument();

    // The whole point of the phase. A button leading to a form that cannot
    // complete would be a worse lie than an empty table.
    expect(screen.queryByRole('link', { name: /enrol/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /enrol/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /register member/i })).toBeNull();
  });

  it('says an empty search is an empty search, not an empty programme', () => {
    render(
      <MembershipRegister page={EMPTY_PAGE} filter={{ query: 'zzz', status: '' }} />,
    );

    expect(screen.getByText(/No memberships match this search/i)).toBeInTheDocument();
  });

  it('offers no savings, withdrawal or benefit control anywhere', () => {
    render(<MembershipRegister page={PAGE} filter={{ query: '', status: '' }} />);

    // The claim is about *controls*, so it is asserted on roles rather than
    // on text. "Withdrawn" is a legitimate status in the filter — the
    // lifecycle state a membership ends in — and a text match would have
    // flagged it, which is how an over-broad assertion becomes one somebody
    // later deletes.
    for (const name of [/collect savings/i, /withdraw/i, /pay benefit/i, /enrol/i]) {
      expect(screen.queryByRole('button', { name }), String(name)).toBeNull();
      expect(screen.queryByRole('link', { name }), String(name)).toBeNull();
    }

    // And no savings or benefit language at all, which has no innocent
    // reading on this screen the way "withdrawn" does.
    expect(screen.queryByText(/collect savings/i)).toBeNull();
    expect(screen.queryByText(/pay benefit/i)).toBeNull();
  });
});

// ===========================================================================
describe('the status badge', () => {
  it('states every status in words rather than in colour alone', () => {
    for (const status of MEMBERSHIP_STATUSES) {
      const { unmount } = render(<MembershipStatusBadge status={status} />);
      expect(screen.getByText(MEMBERSHIP_STATUS_LABELS[status])).toBeInTheDocument();
      unmount();
    }
  });
});

// ===========================================================================
describe('the policy panel', () => {
  it('renders every undecided rule as "Not decided", never as a blank or a zero', () => {
    render(<MembershipPolicyPanel policy={DRAFT_POLICY} />);

    // Eight of the nine appear as a value in the body; the ninth
    // (`qualifyingMonthsConsecutive`) does too. One marker per rule.
    expect(screen.getAllByText('Not decided')).toHaveLength(
      UNDECIDED_POLICY_RULES.length,
    );

    // And no amount is invented for a rule nobody has set.
    expect(screen.queryByText('UGX 0')).toBeNull();
  });

  it('lists every outstanding decision by name, so the reader knows what to ask', () => {
    render(<MembershipPolicyPanel policy={DRAFT_POLICY} />);

    expect(
      screen.getByRole('table', { name: /decisions still outstanding/i }),
    ).toBeInTheDocument();

    expect(
      screen.getByText(/9 of the programme's rules have not been settled/i),
    ).toBeInTheDocument();
  });

  it('says plainly that nothing can run against an unapproved draft', () => {
    render(<MembershipPolicyPanel policy={DRAFT_POLICY} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/draft/i);
  });

  it('renders the confirmed figures the client’s documents state', () => {
    render(<MembershipPolicyPanel policy={DRAFT_POLICY} />);

    expect(screen.getByText('UGX 5,000')).toBeInTheDocument();
    expect(screen.getByText('UGX 50,000')).toBeInTheDocument();
    expect(screen.getByText('UGX 100,000')).toBeInTheDocument();
    expect(screen.getByText('UGX 200,000')).toBeInTheDocument();
    expect(screen.getByText('6 months')).toBeInTheDocument();
    expect(screen.getByText('5 months')).toBeInTheDocument();
  });

  it('drops the warning and the outstanding list once every rule is decided', () => {
    render(<MembershipPolicyPanel policy={DECIDED_POLICY} />);

    expect(screen.queryByText('Not decided')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen.queryByRole('table', { name: /decisions still outstanding/i }),
    ).toBeNull();
  });

  it('answers the five activities separately, not with one verdict', () => {
    render(<MembershipPolicyPanel policy={PARTLY_DECIDED_POLICY} />);

    const table = screen.getByRole('table', {
      name: /whether this version opens them/i,
    });

    // Enrolment, savings and lending are open; benefits and profit sharing
    // are not. One switch could express none of this.
    const rows = within(table).getAllByRole('row').slice(1);
    const verdicts = rows.map((row) => ({
      activity: within(row).getAllByRole('cell')[0]?.textContent ?? '',
      open: (within(row).getAllByRole('cell')[1]?.textContent ?? '').trim(),
    }));

    expect(verdicts).toHaveLength(5);
    expect(verdicts.find((v) => v.activity.includes('Enrolment'))?.open).toBe('Open');
    expect(verdicts.find((v) => v.activity.includes('Member savings'))?.open).toBe(
      'Open',
    );
    expect(verdicts.find((v) => v.activity.includes('Member loans'))?.open).toBe('Open');
    expect(verdicts.find((v) => v.activity.includes('Benefit payments'))?.open).toBe(
      'Closed',
    );
    expect(verdicts.find((v) => v.activity.includes('profit sharing'))?.open).toBe(
      'Closed',
    );
  });

  it('names the decision holding each closed activity up, and nothing else', () => {
    render(<MembershipPolicyPanel policy={PARTLY_DECIDED_POLICY} />);

    const table = screen.getByRole('table', {
      name: /whether this version opens them/i,
    });
    const benefits = within(table)
      .getAllByRole('row')
      .find((row) => row.textContent?.includes('Benefit payments'));

    expect(benefits).toBeDefined();
    // Its own three, and not the profit formula, which holds up a different
    // activity entirely.
    expect(benefits).toHaveTextContent(/medical benefit pays one member in a year/i);
    expect(benefits).toHaveTextContent(/medical claims/i);
    expect(benefits).toHaveTextContent(/benefit may first be claimed/i);
    expect(benefits).not.toHaveTextContent(/profit share is calculated/i);
  });

  it('never tells a reader that an open activity cannot run', () => {
    render(<MembershipPolicyPanel policy={PARTLY_DECIDED_POLICY} />);

    // The old banner said "No membership transaction can run against this
    // version", which was false the moment a version was approved and in
    // force: the registration fee waits on none of the nine.
    expect(screen.queryByText(/no membership transaction can run/i)).toBeNull();
  });

  it('offers no control that would publish or approve a version', () => {
    render(<MembershipPolicyPanel policy={DRAFT_POLICY} />);

    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /publish/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
  });
});

// ===========================================================================
describe('the lifecycle history', () => {
  it('reads forwards, oldest first, because it is a story', () => {
    render(<MembershipHistory events={HISTORY} />);

    const rows = screen.getAllByRole('row');
    // Header, then the two events in the order they happened.
    expect(within(rows[1]!).getByText('Pending')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Active')).toBeInTheDocument();
  });

  it('says "not recorded" rather than leaving the opening row blank', () => {
    render(<MembershipHistory events={HISTORY} />);

    expect(screen.getAllByLabelText('Not recorded').length).toBeGreaterThan(0);
  });

  it('says so when there is no history, rather than rendering an empty grid', () => {
    render(<MembershipHistory events={[]} />);

    expect(screen.getByText(/No status history/i)).toBeInTheDocument();
  });
});

// ===========================================================================
describe('membership on the client record', () => {
  it('says a non-member is not a problem', () => {
    render(<ClientMembershipPanel memberships={[]} />);

    expect(
      screen.getByText(/not a member of the savings and benefits programme/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Membership is optional/i)).toBeInTheDocument();

    // And offers no enrolment action, for the same reason the register does
    // not.
    expect(screen.queryByRole('link', { name: /enrol/i })).toBeNull();
  });

  it('lists every membership the client has held, not only the live one', () => {
    const former: MembershipSummary = {
      ...MEMBER,
      id: 'b7d1a2c3-0000-4000-8000-000000000002',
      membershipNumber: 'MB260002',
      status: 'withdrawn',
      endedOn: '2026-08-01',
    };

    render(<ClientMembershipPanel memberships={[MEMBER, former]} />);

    expect(screen.getByRole('link', { name: 'MB260001' })).toHaveAttribute(
      'href',
      `${ROUTES.membership}/${MEMBER.id}`,
    );
    expect(screen.getByRole('link', { name: 'MB260002' })).toBeInTheDocument();
    expect(screen.getByText('Withdrawn')).toBeInTheDocument();
  });
});

// ===========================================================================
describe('membership navigation', () => {
  it('is a module of its own, between Clients and Loan Management', () => {
    const ids = NAV_MODULES.map((module) => module.id);

    expect(ids).toContain('membership');
    expect(ids.indexOf('membership')).toBe(ids.indexOf('clients') + 1);
    expect(ids.indexOf('membership')).toBe(ids.indexOf('loans') - 1);
  });

  it('requires the same capability the route guard requires', () => {
    const block = NAV_MODULES.find((candidate) => candidate.id === 'membership');

    expect(block).toBeDefined();

    for (const item of block?.items ?? []) {
      const path = item.href.split('?')[0] ?? '';
      expect(permissionForPath(path), item.href).toBe(item.permission);
    }
  });

  it('shows the module to every staff role and to no borrower', () => {
    for (const role of ['secretary_treasurer', 'manager', 'owner_admin'] as const) {
      const ids = visibleNavModules(ROLE_PERMISSIONS[role]).map((module) => module.id);
      expect(ids, role).toContain('membership');
    }

    const borrower = visibleNavModules(ROLE_PERMISSIONS.client).map(
      (module) => module.id,
    );
    expect(borrower).not.toContain('membership');
  });

  it('offers no entry for a workflow that does not exist yet', () => {
    const block = NAV_MODULES.find((candidate) => candidate.id === 'membership');

    for (const item of block?.items ?? []) {
      expect(item.label, item.href).not.toMatch(
        /enrol|register member|collect|savings|withdraw|benefit|meeting|profit/i,
      );
    }
  });

  it('guards the membership routes on membership:view and nothing looser', () => {
    expect(permissionForPath(ROUTES.membership)).toBe('membership:view');
    expect(permissionForPath(ROUTES.membershipPolicies)).toBe('membership:view');
    expect(permissionForPath(`${ROUTES.membership}/abc`)).toBe('membership:view');
  });
});
