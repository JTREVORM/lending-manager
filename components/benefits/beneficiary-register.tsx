'use client';

import { SearchX, UserRoundCheck } from 'lucide-react';

import {
  DataTable,
  TableCell,
  TableHead,
  TableLead,
  TableRow,
} from '@/components/ui/data-table';
import { DateValue } from '@/components/ui/data-value';
import {
  RegisterCount,
  RegisterFilters,
  RegisterPagination,
} from '@/components/ui/register';
import { RowLink } from '@/components/ui/row-link';
import { EmptyState } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import type { BeneficiaryPage } from '@/lib/data/benefits';
import { BENEFICIARY_VERIFICATION_LABELS } from '@/lib/domain/benefits';
import { BeneficiaryStatusBadge, BeneficiaryVerificationBadge } from './benefit-badges';

/**
 * The beneficiary register.
 *
 * ## It exists to make the unverified ones findable
 *
 * That is the whole purpose. A member with an unverified next of kin has a
 * bereavement benefit that cannot be paid, and nobody discovers that at a
 * convenient moment — so this screen opens on everything, filters by
 * verification state, and leads with the badge that says which.
 *
 * ## No name, no telephone number, anywhere on it
 *
 * The register view carries neither, because a beneficiary's name is the
 * business's payment instruction and lives in
 * `member_beneficiary_identities` behind `membership:view_sensitive`. What is
 * here is the record number, the member, the relationship and the state — and
 * that is enough to work the queue. A supervisor reads the name on the
 * record's own page, which is one read with one capability rather than a
 * column nobody could withhold.
 *
 * Search is therefore over the record number, the membership number, the
 * member's name and their client number. Searching the beneficiary's own name
 * would be a way of confirming it without holding the capability.
 */
export function BeneficiaryRegister({
  page,
  filter,
}: {
  readonly page: BeneficiaryPage;
  readonly filter: { readonly query: string; readonly verification: string };
}) {
  const filtered = filter.query !== '' || filter.verification !== '';

  return (
    <div className="min-w-0 space-y-4">
      <RegisterFilters
        search={{
          id: 'beneficiary-search',
          label: 'Search',
          param: 'q',
          value: filter.query,
          placeholder: 'Record number, membership number, member name or client number',
        }}
        selects={[
          {
            id: 'beneficiary-verification',
            label: 'Checked?',
            param: 'verification',
            value: filter.verification,
            options: [
              { value: '', label: 'Any state' },
              {
                value: 'pending_verification',
                label: BENEFICIARY_VERIFICATION_LABELS.pending_verification,
              },
              { value: 'verified', label: BENEFICIARY_VERIFICATION_LABELS.verified },
              { value: 'rejected', label: BENEFICIARY_VERIFICATION_LABELS.rejected },
            ],
          },
        ]}
        summary={
          <RegisterCount
            shown={page.beneficiaries.length}
            page={page.page}
            hasMore={page.hasMore}
            noun="beneficiary record"
          />
        }
      />

      {page.beneficiaries.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : UserRoundCheck}
          title={
            filtered
              ? 'No record matches this search'
              : 'No next of kin has been registered yet'
          }
          description={
            filtered
              ? 'Try a shorter search, or clear the state filter.'
              : 'A beneficiary is registered from the member’s own record. Until one is registered and checked, a bereavement benefit cannot be paid.'
          }
        />
      ) : (
        <>
          {/* Phone: cards. */}
          <ul className="space-y-3 md:hidden">
            {page.beneficiaries.map((beneficiary) => (
              <li key={beneficiary.id}>
                <RowLink
                  href={`${ROUTES.beneficiaries}/${beneficiary.id}`}
                  className="record-surface focus-visible:outline-accent block rounded-lg p-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-text font-medium break-words">
                        {beneficiary.memberName}
                      </p>
                      <p className="text-text-muted font-mono text-sm">
                        {beneficiary.beneficiaryNumber} · {beneficiary.membershipNumber}
                      </p>
                    </div>
                    <div className="shrink-0 space-y-1 text-right">
                      <BeneficiaryVerificationBadge
                        status={beneficiary.verificationStatus}
                      />
                      <div>
                        <BeneficiaryStatusBadge status={beneficiary.status} />
                      </div>
                    </div>
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div className="min-w-0">
                      <dt className="text-text-muted">Relationship</dt>
                      <dd className="text-text">
                        {beneficiary.relationshipLabel}
                        {beneficiary.isPrimary ? ' · primary' : ''}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-text-muted">Registered</dt>
                      <dd className="text-text">
                        <DateValue value={beneficiary.recordedOn} />
                      </dd>
                    </div>
                  </dl>
                </RowLink>
              </li>
            ))}
          </ul>

          {/* Tablet and up: a table. */}
          <div className="hidden min-w-0 md:block">
            <DataTable caption="Beneficiary register, newest record first">
              <thead>
                <tr>
                  <TableHead width="ref">Record</TableHead>
                  <TableHead width="name-wide">Member</TableHead>
                  <TableHead width="name">Relationship</TableHead>
                  <TableHead width="date" hideBelow="lg">
                    Registered
                  </TableHead>
                  <TableHead width="name" hideBelow="xl">
                    Registered by
                  </TableHead>
                  <TableHead width="status">Checked?</TableHead>
                  <TableHead width="status" hideBelow="lg">
                    State
                  </TableHead>
                </tr>
              </thead>
              <tbody>
                {page.beneficiaries.map((beneficiary) => (
                  <TableRow key={beneficiary.id} interactive>
                    <TableCell width="ref" className="font-mono">
                      <RowLink
                        href={`${ROUTES.beneficiaries}/${beneficiary.id}`}
                        className="text-accent focus-visible:outline-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {beneficiary.beneficiaryNumber}
                      </RowLink>
                    </TableCell>
                    <TableCell width="name-wide" wrap="wrap">
                      <TableLead
                        primary={beneficiary.memberName}
                        secondary={beneficiary.membershipNumber}
                      />
                    </TableCell>
                    <TableCell width="name" wrap="clamp">
                      {beneficiary.relationshipLabel}
                      {beneficiary.isPrimary ? (
                        <span className="text-text-muted block text-[11px]">primary</span>
                      ) : null}
                    </TableCell>
                    <TableCell width="date" hideBelow="lg" className="text-text-muted">
                      <DateValue value={beneficiary.recordedOn} />
                    </TableCell>
                    <TableCell width="name" hideBelow="xl" wrap="clamp">
                      {beneficiary.recordedByLabel}
                    </TableCell>
                    <TableCell width="status">
                      <BeneficiaryVerificationBadge
                        status={beneficiary.verificationStatus}
                      />
                    </TableCell>
                    <TableCell width="status" hideBelow="lg">
                      <BeneficiaryStatusBadge status={beneficiary.status} />
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
