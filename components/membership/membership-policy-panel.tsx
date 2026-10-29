import { AlertTriangle } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { DataTable, TableCell, TableHead, TableRow } from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import {
  MEMBER_INTEREST_BASIS_LABELS,
  MEMBER_INTEREST_METHOD_LABELS,
  MEMBERSHIP_ACTIVITY_DESCRIPTIONS,
  MEMBERSHIP_ACTIVITY_LABELS,
  MEMBERSHIP_POLICY_STATUS_LABELS,
  PROFIT_DISTRIBUTION_BASIS_LABELS,
  SAVINGS_WITHDRAWAL_RULE_LABELS,
  UNDECIDED_POLICY_RULE_LABELS,
  membershipActivityReadiness,
  outstandingPolicyDecisions,
  policyBlockedReason,
  type MembershipPolicyStatus,
} from '@/lib/domain/membership';
import { formatBps } from '@/lib/domain/rate';
import type { MembershipPolicy } from '@/lib/data/membership';

/**
 * A membership policy version, read-only.
 *
 * ## Why each activity gets its own row
 *
 * One "this version enables nothing" banner was wrong, and wrong in the
 * direction that costs money: it said the registration fee could not be
 * taken because the year-end profit formula was unsettled. The readiness
 * table below asks the five questions separately — enrolment, savings,
 * lending, benefits, profit sharing — and each answer names only the
 * decisions that activity actually waits on. It is the same split the
 * database enforces in `membership_policy_allows()`, so a reader of this
 * screen and a posting in Polytos Phase 2 are told the same thing.
 *
 * ## Why "undecided" is rendered as a word and never as a blank
 *
 * Nine of the programme's rules have not been settled with the client. Their
 * columns are NULL, and a panel that rendered NULL as an em dash would read
 * exactly like a figure of zero that nobody typed. So an outstanding decision
 * is rendered as the amber word **Not decided**, counted at the top of the
 * panel, and named in a list — because the gap is the most important thing on
 * this screen. A member cannot be enrolled, savings cannot be taken and no
 * benefit can be paid until those nine are answered, and the person reading
 * this screen is usually the person who can answer them.
 *
 * ## Why there is no edit control
 *
 * Polytos Phase 1 delivers the read. Publishing and approving a version is a
 * write that `membership:manage_policies` guards in the database today and
 * that Polytos Phase 2 gives a screen. Rendering a disabled "Edit" button
 * here would be a control that looks operational and is not, which is exactly
 * what the brief asks this phase not to do.
 */

const POLICY_TONES: Readonly<
  Record<MembershipPolicyStatus, 'success' | 'info' | 'neutral'>
> = {
  draft: 'info',
  active: 'success',
  superseded: 'neutral',
};

/** An outstanding decision, said in words rather than left blank. */
function NotDecided() {
  return (
    <span className="text-warning font-medium" title="The client has not decided this">
      Not decided
    </span>
  );
}

export function MembershipPolicyPanel({ policy }: { readonly policy: MembershipPolicy }) {
  const outstanding = outstandingPolicyDecisions(policy);
  const blocked = policyBlockedReason(policy);
  const readiness = membershipActivityReadiness(policy);

  return (
    <div className="min-w-0 space-y-4">
      {blocked === null ? null : (
        <Alert tone="warning">
          <span className="font-medium">{blocked}</span>
        </Alert>
      )}

      <Card>
        <CardHeader
          title="What this version authorises"
          description="Each activity waits on its own decisions, and on nothing else. The database enforces the same five gates separately."
        />

        <DataTable caption="Membership activities and whether this version opens them">
          <thead>
            <tr>
              <TableHead width="prose">Activity</TableHead>
              {/* "Status" rather than "Open": the badges below read Open or
                  Closed, and a header carrying one of those two words is a
                  cell a reader — and a screen reader — has to disambiguate
                  from the values under it. */}
              <TableHead width="status">Status</TableHead>
              <TableHead width="prose">Waiting on</TableHead>
            </tr>
          </thead>
          <tbody>
            {readiness.map((row) => (
              <TableRow key={row.activity}>
                <TableCell width="prose" wrap="wrap">
                  <span className="text-text font-medium">
                    {MEMBERSHIP_ACTIVITY_LABELS[row.activity]}
                  </span>
                  <span className="text-text-muted block text-xs">
                    {MEMBERSHIP_ACTIVITY_DESCRIPTIONS[row.activity]}
                  </span>
                </TableCell>
                <TableCell width="status">
                  <Badge tone={row.ready ? 'success' : 'warning'}>
                    {row.ready ? 'Open' : 'Closed'}
                  </Badge>
                </TableCell>
                <TableCell width="prose" wrap="wrap">
                  {row.ready ? (
                    <span className="text-text-muted">Nothing</span>
                  ) : row.outstanding.length === 0 ? (
                    <span className="text-text-muted">{row.blockedReason}</span>
                  ) : (
                    <ul className="space-y-1">
                      {row.outstanding.map((rule) => (
                        <li key={rule} className="text-text-muted">
                          {UNDECIDED_POLICY_RULE_LABELS[rule]}
                        </li>
                      ))}
                    </ul>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </DataTable>
      </Card>

      <Card>
        <CardHeader
          title={`Version ${policy.version} — ${policy.title}`}
          description={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge tone={POLICY_TONES[policy.status]}>
                {MEMBERSHIP_POLICY_STATUS_LABELS[policy.status]}
              </Badge>
              <span>
                {policy.effectiveFrom === null ? 'Activation date awaiting authorization' : <>Effective from <DateValue value={policy.effectiveFrom} /></>}
              </span>
            </span>
          }
        />

        <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Row label="Approved">
            {policy.approvedAt === null ? (
              <span className="text-warning font-medium">Not approved</span>
            ) : (
              <>
                <DateValue value={policy.approvedAt} variant="datetime" />
                {policy.approvedByLabel === null ? null : (
                  <span className="text-text-muted"> by {policy.approvedByLabel}</span>
                )}
              </>
            )}
          </Row>
          <Row label="Client approval reference">
            {policy.approvalReference ?? <NotRecordedText />}
          </Row>
        </dl>
      </Card>

      {/* --- Membership ----------------------------------------------- */}
      <Card>
        <CardHeader
          title="Membership"
          description="Confirmed by the client's own documents."
        />
        <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Row label="Registration fee">
            <Money amount={policy.registrationFee} />
          </Row>
          <Row label="Minimum monthly savings">
            <Money amount={policy.monthlySavingsMinimum} />
          </Row>
          <Row label="Savings qualification period">
            {policy.savingsQualifyingMonths} months
          </Row>
          <Row label="Qualifying months must be consecutive">
            {policy.qualifyingMonthsConsecutive === null ? (
              <NotDecided />
            ) : policy.qualifyingMonthsConsecutive ? (
              'Yes'
            ) : (
              'No'
            )}
          </Row>
        </dl>
      </Card>

      {/* --- Lending --------------------------------------------------- */}
      <Card>
        <CardHeader
          title="Lending terms"
          description="The advertised rate is confirmed. What it is charged on, and how, is not."
        />
        <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Row label="Member interest rate">
            {formatBps(policy.memberLoanInterestRateBps)}
          </Row>
          <Row label="Interest basis">
            {policy.interestBasis === null ? (
              <NotDecided />
            ) : (
              MEMBER_INTEREST_BASIS_LABELS[policy.interestBasis]
            )}
          </Row>
          <Row label="Interest method">
            {policy.interestMethod === null ? (
              <NotDecided />
            ) : (
              MEMBER_INTEREST_METHOD_LABELS[policy.interestMethod]
            )}
          </Row>
          <Row label="Maximum member loan term">
            {policy.memberLoanMaxTermMonths} months
          </Row>
          <Row label="Weekly collection up to">
            {policy.memberLoanWeeklyCadenceMaxMonths} months, monthly beyond
          </Row>
          <Row label="Maximum non-member loan term">
            {policy.nonMemberLoanMaxTermMonths} months
          </Row>
          <Row label="Borrowing against savings">
            {policy.savingsToLoanMultiplierBps === null ? (
              <NotDecided />
            ) : (
              `${formatBps(policy.savingsToLoanMultiplierBps)} of savings held`
            )}
          </Row>
          <Row label="Withdrawing savings with a live loan">
            {policy.savingsWithdrawalWithActiveLoan === null ? (
              <NotDecided />
            ) : (
              SAVINGS_WITHDRAWAL_RULE_LABELS[policy.savingsWithdrawalWithActiveLoan]
            )}
          </Row>
        </dl>
      </Card>

      {/* --- Benefits --------------------------------------------------- */}
      <Card>
        <CardHeader
          title="Benefits"
          description="The three amounts are confirmed. The limits on the medical benefit are not."
        />
        <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Row label="Medical support">
            {formatBps(policy.medicalBenefitRateBps)} of an eligible hospital bill
          </Row>
          <Row label="Minimum admission">
            Longer than {policy.medicalBenefitMinAdmissionDays}{' '}
            {policy.medicalBenefitMinAdmissionDays === 1 ? 'day' : 'days'}
          </Row>
          <Row label="Medical support, annual limit">
            {policy.medicalBenefitAnnualCap === null ? (
              <NotDecided />
            ) : (
              <Money amount={policy.medicalBenefitAnnualCap} />
            )}
          </Row>
          <Row label="Medical claims a year">
            {policy.medicalBenefitClaimsPerYear ?? <NotDecided />}
          </Row>
          <Row label="Family condolence support">
            <Money amount={policy.familyCondolenceBenefit} />
          </Row>
          <Row label="Member bereavement support">
            <Money amount={policy.memberBereavementBenefit} />
          </Row>
          <Row label="Waiting period before a first claim">
            {policy.benefitWaitingPeriodDays === null ? (
              <NotDecided />
            ) : (
              `${String(policy.benefitWaitingPeriodDays)} days`
            )}
          </Row>
          <Row label="Year-end profit sharing">
            {policy.profitDistributionBasis === null ? (
              <NotDecided />
            ) : (
              PROFIT_DISTRIBUTION_BASIS_LABELS[policy.profitDistributionBasis]
            )}
          </Row>
        </dl>
      </Card>

      {/* --- The outstanding decisions ---------------------------------- */}
      {outstanding.length === 0 ? null : (
        <Card>
          <CardHeader
            title="Decisions still needed from the client"
            description={`${String(outstanding.length)} of the programme's rules have not been settled. The table above says which activity each one is holding up.`}
          />

          <DataTable caption="Membership policy decisions still outstanding">
            <thead>
              <tr>
                <TableHead width="count">#</TableHead>
                <TableHead width="prose">Decision</TableHead>
              </tr>
            </thead>
            <tbody>
              {outstanding.map((rule, index) => (
                <TableRow key={rule}>
                  <TableCell width="count" align="numeric" className="text-text-muted">
                    {index + 1}
                  </TableCell>
                  <TableCell width="prose" wrap="wrap">
                    <span className="inline-flex items-start gap-2">
                      <AlertTriangle
                        aria-hidden="true"
                        className="text-warning mt-0.5 size-4 shrink-0"
                      />
                      {UNDECIDED_POLICY_RULE_LABELS[rule]}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </DataTable>
        </Card>
      )}

      {policy.notes === null ? null : (
        <Card>
          <CardHeader title="Notes" />
          <p className="text-text text-sm break-words whitespace-pre-wrap">
            {policy.notes}
          </p>
        </Card>
      )}
    </div>
  );
}

function NotRecordedText() {
  return (
    <span className="text-text-muted" aria-label="Not recorded">
      —
    </span>
  );
}

function Row({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-sm">{label}</dt>
      <dd className="text-text mt-0.5 break-words">{children}</dd>
    </div>
  );
}
