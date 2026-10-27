'use client';

import { HeartHandshake, SearchX } from 'lucide-react';

import {
  DataTable,
  NotRecorded,
  TableCell,
  TableHead,
  TableLead,
  TableRow,
} from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import {
  RegisterCount,
  RegisterFilters,
  RegisterPagination,
} from '@/components/ui/register';
import { RowLink } from '@/components/ui/row-link';
import { EmptyState } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import {
  BENEFIT_CLAIM_TYPES,
  BENEFIT_CLAIM_TYPE_LABELS,
  BENEFIT_CLAIM_STATUSES,
  BENEFIT_CLAIM_STATUS_LABELS,
} from '@/lib/domain/benefits';
import type { BenefitClaimPage } from '@/lib/data/benefits';
import {
  BenefitClaimStatusBadge,
  BenefitClaimTypeBadge,
  EvidenceProgressBadge,
} from './benefit-badges';

/**
 * The benefit claim register.
 *
 * The same three pieces every register here uses — `RegisterFilters`,
 * `DataTable`, `RegisterPagination` — so somebody who can read the savings
 * register can read this one without learning anything. Filters live in the
 * URL, which is what makes a filtered view reloadable and, more importantly,
 * makes the filtering happen in the database: Row Level Security applies to
 * the filtered query rather than to a full list trimmed in the browser.
 *
 * Cards on a phone, a table from `md` up. A table at 390px either scrolls
 * sideways or crushes its columns, and neither is usable one-handed by
 * somebody standing at a counter with a bereaved family in front of them.
 *
 * ## The lead column on a phone is the status, not the amount
 *
 * Savings put the balance in the lead, because the question a counter asks of
 * that register is "what does this member hold". The question asked of *this*
 * one is almost always "where has this claim got to" — and the amount is often
 * not decided yet. So the status pill and the evidence progress sit beside the
 * member's name, and the money is in the detail grid.
 *
 * ## What the register deliberately does not show
 *
 * No beneficiary name, on any claim. The register view carries none: a
 * beneficiary's name is the business's payment instruction and lives in
 * `member_beneficiary_identities` behind `membership:view_sensitive`. What it
 * shows instead is *whether* a bereavement claim has a verified payee, which
 * is what somebody working the queue needs.
 *
 * The hospital and the deceased's name are shown on a claim's own row and are
 * **not searchable**, which is a narrower thing than it looks: searching a
 * column implies being able to confirm its contents, and typing enough
 * guesses into a box that matched a hospital would confirm which members had
 * been admitted where.
 */
export function BenefitClaimRegister({
  page,
  filter,
}: {
  readonly page: BenefitClaimPage;
  readonly filter: {
    readonly query: string;
    readonly status: string;
    readonly type: string;
  };
}) {
  const filtered = filter.query !== '' || filter.status !== '' || filter.type !== '';

  return (
    <div className="min-w-0 space-y-4">
      <RegisterFilters
        search={{
          id: 'benefit-claim-search',
          label: 'Search',
          param: 'q',
          value: filter.query,
          placeholder: 'Claim number, membership number, member name or client number',
        }}
        selects={[
          {
            id: 'benefit-claim-type',
            label: 'Benefit',
            param: 'type',
            value: filter.type,
            options: [
              { value: '', label: 'All benefits' },
              ...BENEFIT_CLAIM_TYPES.map((type) => ({
                value: type,
                label: BENEFIT_CLAIM_TYPE_LABELS[type],
              })),
            ],
          },
          {
            id: 'benefit-claim-status',
            label: 'Stage',
            param: 'status',
            value: filter.status,
            options: [
              { value: '', label: 'All stages' },
              // A view the page offers and the database does not: every stage
              // a claim can still move out of. It is what somebody working a
              // queue wants, and no single column holds it.
              { value: 'open', label: 'Still open' },
              ...BENEFIT_CLAIM_STATUSES.map((status) => ({
                value: status,
                label: BENEFIT_CLAIM_STATUS_LABELS[status],
              })),
            ],
          },
        ]}
        summary={
          <RegisterCount
            shown={page.claims.length}
            page={page.page}
            hasMore={page.hasMore}
            noun="benefit claim"
          />
        }
      />

      {page.claims.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : HeartHandshake}
          title={filtered ? 'No claim matches this search' : 'No benefit claims yet'}
          description={
            filtered
              ? 'Try a shorter search, or clear the benefit and stage filters.'
              : 'A claim is opened for a member when they bring in a hospital bill or report a death. Open one from this section, or from the member’s own record.'
          }
        />
      ) : (
        <>
          {/* Phone: cards. */}
          <ul className="space-y-3 md:hidden">
            {page.claims.map((claim) => (
              <li key={claim.id}>
                <RowLink
                  href={`${ROUTES.benefitClaims}/${claim.id}`}
                  className="record-surface focus-visible:outline-accent block rounded-lg p-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-text font-medium break-words">
                        {claim.memberName}
                      </p>
                      <p className="text-text-muted font-mono text-sm">
                        {claim.claimNumber}
                      </p>
                    </div>
                    <div className="shrink-0 space-y-1 text-right">
                      <BenefitClaimStatusBadge status={claim.status} />
                      <div>
                        <EvidenceProgressBadge
                          verified={claim.verifiedDocumentCount}
                          required={claim.requiredDocumentCount}
                        />
                      </div>
                    </div>
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div className="min-w-0">
                      <dt className="text-text-muted">Benefit</dt>
                      <dd className="text-text">
                        {BENEFIT_CLAIM_TYPE_LABELS[claim.claimType]}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Event</dt>
                      <dd className="text-text">
                        <DateValue value={claim.eventDate} />
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Membership</dt>
                      <dd className="text-text font-mono">{claim.membershipNumber}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">
                        {claim.approvedAmount === null ? 'Claimed' : 'Approved'}
                      </dt>
                      <dd className="text-text tabular-nums">
                        {claim.approvedAmount === null ? (
                          claim.claimedAmount === null ? (
                            <NotRecorded />
                          ) : (
                            <Money amount={claim.claimedAmount} />
                          )
                        ) : (
                          <Money amount={claim.approvedAmount} weight="semibold" />
                        )}
                      </dd>
                    </div>
                  </dl>
                </RowLink>
              </li>
            ))}
          </ul>

          {/* Tablet and up: a table. */}
          <div className="hidden min-w-0 md:block">
            <DataTable caption="Benefit claim register, newest claim first">
              <thead>
                <tr>
                  <TableHead width="ref">Claim</TableHead>
                  <TableHead width="name-wide">Member</TableHead>
                  <TableHead width="status">Benefit</TableHead>
                  <TableHead width="date" hideBelow="lg">
                    Event
                  </TableHead>
                  <TableHead width="money" align="numeric">
                    Claimed
                  </TableHead>
                  <TableHead width="money" align="numeric" hideBelow="xl">
                    Decided
                  </TableHead>
                  <TableHead width="status" hideBelow="lg">
                    Evidence
                  </TableHead>
                  <TableHead width="status">Stage</TableHead>
                </tr>
              </thead>
              <tbody>
                {page.claims.map((claim) => (
                  <TableRow key={claim.id} interactive>
                    <TableCell width="ref" className="font-mono">
                      <RowLink
                        href={`${ROUTES.benefitClaims}/${claim.id}`}
                        className="text-accent focus-visible:outline-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {claim.claimNumber}
                      </RowLink>
                    </TableCell>
                    <TableCell width="name-wide" wrap="wrap">
                      <TableLead
                        primary={claim.memberName}
                        secondary={claim.membershipNumber}
                      />
                    </TableCell>
                    <TableCell width="status">
                      <BenefitClaimTypeBadge type={claim.claimType} />
                    </TableCell>
                    <TableCell width="date" hideBelow="lg" className="text-text-muted">
                      <DateValue value={claim.eventDate} />
                    </TableCell>
                    <TableCell width="money" align="numeric">
                      {claim.claimedAmount === null ? (
                        <NotRecorded />
                      ) : (
                        <Money amount={claim.claimedAmount} />
                      )}
                    </TableCell>
                    <TableCell width="money" align="numeric" hideBelow="xl">
                      {claim.approvedAmount === null ? (
                        <NotRecorded />
                      ) : (
                        <Money amount={claim.approvedAmount} weight="semibold" />
                      )}
                    </TableCell>
                    <TableCell width="status" hideBelow="lg">
                      <EvidenceProgressBadge
                        verified={claim.verifiedDocumentCount}
                        required={claim.requiredDocumentCount}
                      />
                    </TableCell>
                    <TableCell width="status">
                      <BenefitClaimStatusBadge status={claim.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </DataTable>
          </div>
        </>
      )}

      <RegisterPagination page={page.page} hasMore={page.hasMore} />
    </div>
  );
}
