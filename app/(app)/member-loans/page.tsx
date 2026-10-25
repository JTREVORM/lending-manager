import { HandCoins } from 'lucide-react';

import { MemberEligibilityRegister } from '@/components/member-loans/eligibility-register';
import { MemberLendingStatus } from '@/components/member-loans/member-lending-status';
import { MemberLoanRegister } from '@/components/member-loans/member-loan-register';
import { MemberLoanSummaryPanel } from '@/components/member-loans/member-loan-summary-panel';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import {
  getMemberLendingState,
  getMemberLoanSummary,
  listMemberEligibility,
  listMemberLoans,
} from '@/lib/data/member-loans';
import {
  memberEligibilitySearchSchema,
  memberLoanSearchSchema,
} from '@/lib/validation/member-loan';

export const metadata = { title: 'Member Loans' };

/**
 * The Member Loans section.
 *
 * Guarded three times, in the shape every section here uses: the proxy refuses
 * an anonymous request, the layout applies the route requirement, and this page
 * states `member_loans:view_eligibility` again explicitly so the requirement
 * stays visible at the surface that depends on it. Beneath all of it, Row Level
 * Security means a caller without the capability gets no rows however they ask.
 *
 * ## Two registers, because there are two questions
 *
 * "Who can borrow" and "who has borrowed" are asked by the same person at
 * different moments and answered from different tables, so they are two views
 * rather than one list. A member with no loan has no row in the loan register
 * and a cleared loan has no bearing on eligibility; merging them would produce
 * a list where most rows were empty in most columns.
 *
 * They are reached from the **sidebar** rather than from a strip of tabs above
 * the register, which is the Phase 21 decision restated: the Member Lending
 * module already lists both, so a strip here would be a second copy of one
 * navigation and the only one of the two that could fall out of step with it.
 * One screen, one register, one query — `?tab=` narrows the heading and the
 * rows, and nothing else about the page changes.
 *
 * ## The banner is about member lending, and only about member lending
 *
 * Savings are open or shut on their own two questions, and the savings screen
 * says so. This one asks whether a member loan can be *priced and scheduled*,
 * which is four different decisions, and names each one that is missing. A
 * banner that announced the whole programme was paralysed would be both untrue
 * and counter-productive — Phase 1's lesson, restated.
 */
export default async function MemberLoansPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await guardPermission(
    ROUTES.memberLoans,
    'member_loans:view_eligibility',
  );
  const params = await searchParams;

  const tab = params.tab === 'loans' ? 'loans' : 'members';

  const eligibilityFilter = memberEligibilitySearchSchema.safeParse({
    query: typeof params.q === 'string' ? params.q : '',
    qualified: typeof params.qualified === 'string' ? params.qualified : 'all',
    sort: typeof params.sort === 'string' ? params.sort : 'savings',
    page: typeof params.page === 'string' ? params.page : '1',
  });

  const loanFilter = memberLoanSearchSchema.safeParse({
    query: typeof params.q === 'string' ? params.q : '',
    status: typeof params.status === 'string' ? params.status : 'all',
    page: typeof params.page === 'string' ? params.page : '1',
  });

  // A malformed filter in the URL falls back to the default view rather than
  // erroring: the filter is a convenience, not a control.
  const eligibility = eligibilityFilter.success
    ? eligibilityFilter.data
    : { query: null, qualified: 'all' as const, sort: 'savings' as const, page: 1 };

  const loans = loanFilter.success
    ? loanFilter.data
    : { query: null, status: 'all' as const, page: 1 };

  const [summary, lending, eligibilityPage, loanPage] = await Promise.all([
    getMemberLoanSummary(),
    getMemberLendingState(),
    tab === 'members'
      ? listMemberEligibility({
          query: eligibility.query,
          qualified: eligibility.qualified ?? 'all',
          sort: eligibility.sort ?? 'savings',
          page: eligibility.page ?? 1,
        })
      : Promise.resolve({ rows: [], page: 1, hasMore: false }),
    tab === 'loans'
      ? listMemberLoans({
          query: loans.query,
          status: loans.status ?? 'all',
          page: loans.page ?? 1,
        })
      : Promise.resolve({ rows: [], page: 1, hasMore: false }),
  ]);

  const canApply = contextCan(context, 'member_loans:create');

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Member Lending"
        icon={HandCoins}
        title={tab === 'loans' ? 'Member Loans' : 'Who can borrow'}
        description={
          tab === 'loans'
            ? 'Member loans, with the membership and the savings securing each one. A member loan opens in the loan register like every other loan.'
            : 'Every live membership, the qualifying months each has served, and what their savings support. The ceiling is absent until the business decides the multiple of savings a member may borrow.'
        }
        primaryAction={
          canApply ? (
            <ActionLink href={ROUTES.newMemberLoan}>New application</ActionLink>
          ) : undefined
        }
        secondaryActions={
          <ActionLink
            href={`${ROUTES.memberLoans}?tab=${tab === 'loans' ? 'members' : 'loans'}`}
            variant="secondary"
          >
            {tab === 'loans' ? 'Who can borrow' : 'Member loans'}
          </ActionLink>
        }
      />

      <MemberLendingStatus
        state={lending}
        blockedReason={summary?.blockedReason ?? null}
      />

      <MemberLoanSummaryPanel summary={summary} />

      {tab === 'members' ? (
        <MemberEligibilityRegister
          page={eligibilityPage}
          filter={{
            query: eligibility.query ?? '',
            qualified: eligibility.qualified ?? 'all',
            sort: eligibility.sort ?? 'savings',
          }}
          canApply={canApply}
        />
      ) : (
        <MemberLoanRegister
          page={loanPage}
          filter={{
            query: loans.query ?? '',
            status: loans.status ?? 'all',
          }}
        />
      )}
    </div>
  );
}
