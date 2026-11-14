import { UserCheck } from 'lucide-react';

import { AgencyReadError } from '@/components/agency/read-failure';
import {
  AssignOperatorForm,
  RevokeOperatorForm,
} from '@/components/agency/staffing-forms';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getAgencyAccountRosters, getBankingStaffOptions } from '@/lib/data/agency';
import type { AgencyStaffedAccount, BankingStaffOption } from '@/lib/domain/agency';

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The module a request asks for, or `null` for both.
 *
 * One roster serves both modules, because a bank agent account and a Mobile
 * Money line are one row of `agency_provider_float_accounts`. The filter is
 * what lets the Agent Banking branch and the Mobile Money branch each lead to
 * the authorisations that belong to it, which is the same arrangement the
 * reporting hub and the account register use: the level is the filter, not a
 * second screen that could disagree with the first.
 *
 * Anything else is read as "both" rather than refused. A bad value in a query
 * string is a stale bookmark, and the honest answer to one is the unfiltered
 * list — what a reader may see is decided by the route's capability and by
 * Row Level Security on the view, neither of which this parameter touches.
 */
function readCategory(params: SearchParams): 'agency_banking' | 'mobile_money' | null {
  const raw = params.category;
  if (raw === 'agency_banking' || raw === 'mobile_money') return raw;
  return null;
}

const MODULE_NAME = {
  agency_banking: 'Agent Banking',
  mobile_money: 'Mobile Money',
} as const;

export async function generateMetadata({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}): Promise<{ readonly title: string }> {
  const category = readCategory(await searchParams);
  return {
    title:
      category === null
        ? 'Account authorisations'
        : `${MODULE_NAME[category]} authorisations`,
  };
}

/** What an account's state means for its roster. */
function AccountBadge({ status }: { readonly status: string }) {
  if (status === 'suspended') return <Badge tone="warning">Suspended</Badge>;
  if (status === 'closed') return <Badge tone="neutral">Closed</Badge>;
  return <Badge tone="success">Active</Badge>;
}

/** An account's name, the way the rest of the Agency module names it. */
function accountName(account: AgencyStaffedAccount): string {
  if (account.accountLabel !== null && account.accountLabel.trim() !== '') {
    return account.accountLabel;
  }
  return account.tillName === '' ? 'Unnamed account' : `Till ${account.tillName}`;
}

/**
 * Who may operate which agent account.
 *
 * ## The rule this screen administers
 *
 * Client Rule 6: "A single agent may operate accounts across multiple banks,
 * with clear account-level transaction ownership and authorization." The
 * Owner's decision 2 made the second half of that explicit — "Unassigned
 * staff must not be able to record or post financial transactions against
 * those accounts."
 *
 * ## Why this screen is not the control
 *
 * It administers a list. The control is two triggers, one on the agency
 * transaction engine and one on float trades, which refuse an officer who is
 * not on the account's roster — whatever this screen shows and however the
 * request arrived. That matters for a reason worth stating plainly: a reader
 * of this page should not conclude the authorisation is a property of the
 * user interface. Remove this page and the refusals stand.
 *
 * ## The oversight clause, and why it is load-bearing
 *
 * `agency_may_operate_account()` returns true for anyone holding
 * `agency:verify`. Without that clause the roster would deadlock: posting is
 * refused to whoever recorded, so an account with exactly one authorised
 * cashier could never have anything posted at all. A Manager posting against
 * an account they are not on is therefore correct and intended, and the panel
 * below says so — because an Owner reading a roster of two names and seeing a
 * third person's posting would otherwise reasonably think the control had
 * failed.
 *
 * ## Why an account with nobody on it is shown rather than hidden
 *
 * It is the one that needs attention. Nothing can be recorded against it
 * except by a Manager under the oversight clause, which is a supervisor doing
 * a cashier's work. The reader opened this page to fix exactly that.
 */
export default async function AgencyStaffingPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}) {
  await guardPermission(ROUTES.agencyStaffing, 'agency:providers');

  const category = readCategory(await searchParams);

  const [allRosters, staff] = await Promise.all([
    getAgencyAccountRosters(),
    getBankingStaffOptions(),
  ]);

  if (!allRosters.ok) return <AgencyReadError failure={allRosters} />;

  // Filtered here rather than in the reader: the reader answers "every agent
  // account and its roster", which is one question with one answer, and a
  // reader that took a category would be two code paths for the counts this
  // page and the branch headings both depend on.
  const rosters = {
    ok: true as const,
    rows:
      category === null
        ? allRosters.rows
        : allRosters.rows.filter((a) => a.providerCategory === category),
  };

  /**
   * Who may be offered for one account: an employee of that account's own
   * branch who is not already on its roster.
   *
   * The branch rule is the database's — `assign_agency_account_staff()`
   * refuses a mandate across branches — and narrowing here only saves the
   * Owner from picking a name that would be refused. An employee carrying no
   * branch at all is excluded for the same reason: the function resolves the
   * account's branch and compares, and a null never matches it.
   */
  const candidatesFor = (
    account: AgencyStaffedAccount,
  ): readonly BankingStaffOption[] => {
    if (!staff.ok) return [];
    const already = new Set(account.operators.map((o) => o.profileId));
    return staff.rows.filter(
      (person) => !already.has(person.profileId) && person.branchId === account.branchId,
    );
  };

  const unstaffed = rosters.rows.filter(
    (a) => a.operators.length === 0 && a.accountStatus !== 'closed',
  );

  return (
    <>
      <PageHeader
        icon={UserCheck}
        eyebrow="Agency"
        title={
          category === null
            ? 'Account authorisations'
            : `${MODULE_NAME[category]} authorisations`
        }
        description={
          category === null
            ? 'Who may record and post against each agent account and each Mobile Money line.'
            : `Who may record and post against each ${category === 'agency_banking' ? 'bank agent account' : 'Mobile Money line'}.`
        }
      />

      <Alert tone="info" title="What this list does and does not decide">
        <p>
          An employee on an account&rsquo;s list may record transactions against it. One
          employee can be authorised on accounts at several banks; each is a separate
          decision, kept with the account.
        </p>
        <p className="mt-2">
          A Manager or Owner may still post against any account in their branch without
          appearing here. That is deliberate: posting is refused to whoever recorded, so
          an account with one authorised cashier would otherwise have no second officer at
          all.
        </p>
      </Alert>

      {unstaffed.length === 0 ? null : (
        <Alert
          tone="warning"
          title={`${String(unstaffed.length)} account${unstaffed.length === 1 ? '' : 's'} with nobody authorised`}
          className="mt-3"
        >
          Nothing can be recorded against{' '}
          {unstaffed.map((a) => accountName(a)).join(', ')} except by a supervisor under
          the oversight above. Authorise the cashier who works the counter.
        </Alert>
      )}

      {staff.ok ? null : (
        <Alert
          tone="warning"
          title="The employee list could not be read"
          className="mt-3"
        >
          The rosters below are current. New authorisations cannot be made until the
          employee list is available.
        </Alert>
      )}

      {rosters.rows.length === 0 ? (
        <Alert tone="info" title="No accounts yet" className="mt-4">
          An authorisation is made against a registered{' '}
          {category === 'mobile_money' ? 'Mobile Money line' : 'agent account'}, and none
          is registered for a branch you can see.
        </Alert>
      ) : (
        <div className="mt-4 min-w-0 space-y-4">
          {rosters.rows.map((account) => (
            <Card key={account.floatAccountId}>
              <CardHeader
                title={`${account.providerName} — ${accountName(account)}`}
                description={`${account.branchName} · ${account.operators.length === 0 ? 'nobody authorised' : `${String(account.operators.length)} authorised`}`}
                action={<AccountBadge status={account.accountStatus} />}
              />

              <div className="grid min-w-0 gap-4 md:grid-cols-2">
                <div className="min-w-0 space-y-3">
                  <h3 className="text-text-muted text-xs font-semibold uppercase">
                    Authorised
                  </h3>
                  {account.operators.length === 0 ? (
                    <p className="text-text-muted text-sm">
                      Nobody. A cashier authorised here can record against this account;
                      until then only a supervisor can.
                    </p>
                  ) : (
                    <ul className="min-w-0 space-y-3">
                      {account.operators.map((operator) => (
                        <li
                          key={operator.id}
                          className="border-border min-w-0 border-b pb-3 last:border-0"
                        >
                          <p className="text-sm font-medium">{operator.staffName}</p>
                          <p className="text-text-muted text-xs">
                            Authorised by {operator.assignedByName} on{' '}
                            <DateValue value={operator.assignedAt} />
                            {operator.notes === null ? '' : ` · ${operator.notes}`}
                          </p>
                          <div className="mt-2">
                            <RevokeOperatorForm
                              floatAccountId={account.floatAccountId}
                              profileId={operator.profileId}
                              staffName={operator.staffName}
                            />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="min-w-0 space-y-4">
                  <div className="min-w-0">
                    <h3 className="text-text-muted mb-3 text-xs font-semibold uppercase">
                      Authorise somebody
                    </h3>
                    <AssignOperatorForm
                      account={account}
                      candidates={candidatesFor(account)}
                    />
                  </div>

                  {account.withdrawn.length === 0 ? null : (
                    <details className="min-w-0">
                      <summary className="text-text-muted cursor-pointer text-xs font-semibold uppercase">
                        Withdrawn ({account.withdrawn.length})
                      </summary>
                      <ul className="mt-2 min-w-0 space-y-2">
                        {account.withdrawn.map((operator) => (
                          <li key={operator.id} className="text-text-muted text-xs">
                            <span className="text-text font-medium">
                              {operator.staffName}
                            </span>{' '}
                            — withdrawn by {operator.revokedByName ?? 'unknown'} on{' '}
                            {operator.revokedAt === null ? (
                              'an unrecorded date'
                            ) : (
                              <DateValue value={operator.revokedAt} />
                            )}
                            {operator.revokedReason === null
                              ? ''
                              : `: ${operator.revokedReason}`}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
