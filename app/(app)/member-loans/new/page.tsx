import { HandCoins } from 'lucide-react';

import { MemberLoanApplicationForm } from '@/components/member-loans/member-loan-application-form';
import { MemberLendingStatus } from '@/components/member-loans/member-lending-status';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import {
  assessMemberLoanEligibility,
  getMemberLendingState,
  memberLoanBusinessDate,
} from '@/lib/data/member-loans';
import { businessToday } from '@/lib/domain/datetime';

export const metadata = { title: 'New member loan' };

/**
 * A member loan application.
 *
 * ## Why this screen needs a client before it can do anything
 *
 * Because a member loan is assessed against a particular person's savings
 * history, and there is nothing to show without one. So the screen arrives
 * from the eligibility panel on a membership record — which is where somebody
 * decides this member should apply — and says so plainly when it arrives
 * without one, rather than offering a chooser that duplicates the register
 * one tap earlier.
 *
 * ## Guarded by `member_loans:create`, not by the section's capability
 *
 * `/member-loans` is behind `member_loans:view_eligibility`, which the
 * Secretary/Treasurer holds: answering "do I qualify yet?" is counter work.
 * Opening an application commits the business to lend against member savings,
 * which is not. The longer route prefix is listed first in
 * `lib/auth/routing.ts` precisely so this page does not inherit the section's
 * floor.
 */
export default async function NewMemberLoanPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await guardPermission(ROUTES.newMemberLoan, 'member_loans:create');
  const params = await searchParams;

  const clientId = typeof params.client === 'string' ? params.client : null;

  const [lending, businessDate] = await Promise.all([
    getMemberLendingState(),
    memberLoanBusinessDate(),
  ]);

  const today = businessDate ?? businessToday();

  if (clientId === null) {
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Member Lending"
          icon={HandCoins}
          back={{ href: ROUTES.memberLoans, label: 'Member Loans' }}
          title="New member loan"
        />

        <MemberLendingStatus state={lending} />

        <EmptyState
          icon={HandCoins}
          title="Choose a member first"
          description="A member loan is assessed against one member's savings history, so this form needs a member before it can show anything. Open the member's record from the eligibility register and start the application from the panel there — it carries the assessment the business will decide on."
        />
      </div>
    );
  }

  const eligibility = await assessMemberLoanEligibility(clientId);

  if (eligibility === null) {
    return (
      <div className="min-w-0 space-y-6">
        <PageHeader
          eyebrow="Member Lending"
          icon={HandCoins}
          back={{ href: ROUTES.memberLoans, label: 'Member Loans' }}
          title="New member loan"
        />

        <Alert tone="danger" title="This member could not be assessed">
          There is no such client, or this record is not one you may see. Either answer is
          the same here on purpose: a screen that distinguished them would confirm a
          record exists to somebody who may not read it.
        </Alert>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Member Lending"
        icon={HandCoins}
        back={{ href: ROUTES.memberLoans, label: 'Member Loans' }}
        title="New member loan"
        description={
          eligibility.membershipNumber === null
            ? 'This client is not a member of the savings programme.'
            : `For ${eligibility.membershipNumber}, under policy version ${eligibility.policyVersion ?? '—'}.`
        }
      />

      <MemberLendingStatus state={lending} />

      {eligibility.membershipId === null ? (
        <Card>
          <h2 className="text-text text-sm font-semibold">
            This client cannot take a member loan
          </h2>
          <ul className="text-text-muted mt-2 min-w-0 list-disc space-y-1 pl-5 text-sm">
            {eligibility.blockingReasons.map((reason) => (
              <li key={reason} className="min-w-0 break-words">
                {reason}
              </li>
            ))}
          </ul>
          <p className="text-text-muted mt-3 text-sm">
            An ordinary loan product is unaffected: a client may borrow without being a
            member, and the loan register is where that application starts.
          </p>
        </Card>
      ) : (
        <MemberLoanApplicationForm
          eligibility={eligibility}
          lending={lending}
          businessDate={today}
        />
      )}
    </div>
  );
}
