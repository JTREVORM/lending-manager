import { UserRoundCheck } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  BeneficiaryStatusBadge,
  BeneficiaryVerificationBadge,
} from '@/components/benefits/benefit-badges';
import { BenefitDocumentsPanel } from '@/components/benefits/benefit-documents-panel';
import { BeneficiaryVerificationPanel } from '@/components/benefits/beneficiary-verification-panel';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { PhoneValue } from '@/components/ui/data-value';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import {
  getBeneficiary,
  getBeneficiaryIdentity,
  listBeneficiariesForMembership,
  listBeneficiaryDocuments,
  listBenefitDocumentKinds,
} from '@/lib/data/benefits';
import {
  BENEFICIARY_EVIDENCE_KIND_LABELS,
  BENEFICIARY_IDENTITY_DOCUMENT_LABELS,
  type BeneficiaryEvidenceKind,
  type BeneficiaryIdentityDocumentKind,
} from '@/lib/domain/benefits';
import { signedBenefitDocumentUrl } from '@/lib/storage/benefit-documents';

export const metadata = { title: 'Beneficiary record' };

/**
 * One beneficiary record: who it names, whether anybody checked it, what it
 * replaced, and what replaced it.
 *
 * ## The name is a separate read, and its absence is not an error
 *
 * `getBeneficiaryIdentity` returns `null` for a caller without
 * `membership:view_sensitive` — because the name, the telephone numbers and
 * the identity document live in `member_beneficiary_identities`, a separate
 * table, behind a separate policy. Row Level Security is row-level, so
 * withholding *columns* means withholding a row in another table; that is why
 * the split exists, and it follows `client_identities` from Phase 1.
 *
 * So a Secretary/Treasurer reads "a verified spouse, registered on 4 October"
 * and a Manager reads the name — from this one page, with no branch in the
 * data module and no capability check in this file.
 *
 * ## The history is the point of the design
 *
 * A changed beneficiary is a new record that supersedes the old one; nothing
 * is edited and nothing is deleted. So this page shows the chain, and a
 * superseded record keeps its own verification — which is what makes a
 * payment made against it years ago still explicable.
 */
export default async function BeneficiaryPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly beneficiaryId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await guardPermission(ROUTES.beneficiaries, 'beneficiaries:view');
  const { beneficiaryId } = await params;
  const query = await searchParams;

  const beneficiary = await getBeneficiary(beneficiaryId);

  if (beneficiary === null) notFound();

  const [identity, documents, kinds, siblings] = await Promise.all([
    getBeneficiaryIdentity(beneficiary.id),
    listBeneficiaryDocuments(beneficiary.id),
    listBenefitDocumentKinds(),
    listBeneficiariesForMembership(beneficiary.membershipId),
  ]);

  const signed = await Promise.all(
    documents.map(async (document) => ({
      id: document.id,
      url: await signedBenefitDocumentUrl(document.objectPath),
    })),
  );

  const urls: Record<string, string> = {};
  for (const entry of signed) {
    if (entry.url !== null) urls[entry.id] = entry.url;
  }

  const canManage = contextCan(context, 'beneficiaries:manage');
  const canVerify = contextCan(context, 'beneficiaries:verify');

  const history = siblings.filter((row) => row.id !== beneficiary.id);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Membership Benefits"
        icon={UserRoundCheck}
        title={`Beneficiary ${beneficiary.beneficiaryNumber}`}
        description={`${beneficiary.relationshipLabel} of ${beneficiary.memberName} · ${beneficiary.membershipNumber}`}
        back={{ href: ROUTES.beneficiaries, label: 'Next of kin' }}
        secondaryActions={
          canManage && beneficiary.status === 'active' ? (
            <ActionLink
              href={`${ROUTES.beneficiaries}/new?membershipId=${beneficiary.membershipId}&supersedes=${beneficiary.id}`}
              variant="secondary"
            >
              Replace this record
            </ActionLink>
          ) : undefined
        }
      />

      {query.registered === '1' ? (
        <Alert tone="success" title="Beneficiary registered">
          The record is saved and unverified. Somebody other than whoever recorded it has
          to check it against a document before a bereavement benefit can be assessed.
        </Alert>
      ) : null}

      <Card>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="text-text mr-auto text-sm font-semibold">The record</h2>
          <BeneficiaryVerificationBadge status={beneficiary.verificationStatus} />
          <BeneficiaryStatusBadge status={beneficiary.status} />
        </div>

        <dl className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Line label="Member">
            <Link
              href={`${ROUTES.membership}/${beneficiary.membershipId}`}
              className="text-accent underline-offset-2 hover:underline"
            >
              {beneficiary.memberName}
            </Link>
            <span className="text-text-muted block font-mono text-xs">
              {beneficiary.membershipNumber} · {beneficiary.clientNumber}
            </span>
          </Line>
          <Line label="Relationship">
            {beneficiary.relationshipLabel}
            {beneficiary.isPrimary ? (
              <span className="text-text-muted block text-xs">
                The member&rsquo;s primary next of kin
              </span>
            ) : null}
          </Line>
          <Line label="Registered">
            <DateValue value={beneficiary.recordedOn} />
            <span className="text-text-muted block text-xs">
              by {beneficiary.recordedByLabel}
            </span>
          </Line>

          {identity === null ? (
            <Line label="Who they are">
              <span className="text-text-muted">
                Restricted. Reading a beneficiary&rsquo;s name and telephone number needs
                the sensitive-detail permission, because it is the business&rsquo;s
                payment instruction.
              </span>
            </Line>
          ) : (
            <>
              <Line label="Name">
                <span className="font-medium break-words">{identity.fullName}</span>
              </Line>
              <Line label="Telephone">
                <PhoneValue value={identity.phone} />
                {identity.alternativePhone === null ? null : (
                  <span className="text-text-muted block text-xs">
                    also <PhoneValue value={identity.alternativePhone} />
                  </span>
                )}
              </Line>
              <Line label="Where they live">
                {identity.villageArea ?? '—'}
                {identity.district === null ? null : (
                  <span className="text-text-muted block text-xs">
                    {identity.district}
                  </span>
                )}
              </Line>
              <Line label="Document shown">
                {identity.identityDocumentKind === null
                  ? 'None recorded'
                  : (BENEFICIARY_IDENTITY_DOCUMENT_LABELS[
                      identity.identityDocumentKind as BeneficiaryIdentityDocumentKind
                    ] ?? identity.identityDocumentKind)}
                {identity.identityReference === null ? null : (
                  <span className="text-text-muted block font-mono text-xs">
                    {identity.identityReference}
                  </span>
                )}
              </Line>
            </>
          )}

          {beneficiary.verifiedAt === null ? null : (
            <Line label="Checked">
              <DateValue value={beneficiary.verifiedAt} variant="datetime" />
              <span className="text-text-muted block text-xs">
                by {beneficiary.verifiedByLabel ?? 'an archived account'}
                {beneficiary.verificationEvidenceKind === null
                  ? ''
                  : ` · ${
                      BENEFICIARY_EVIDENCE_KIND_LABELS[
                        beneficiary.verificationEvidenceKind as BeneficiaryEvidenceKind
                      ] ?? beneficiary.verificationEvidenceKind
                    }`}
              </span>
            </Line>
          )}

          {beneficiary.supersedesNumber === null ? null : (
            <Line label="Replaces">
              <span className="font-mono">{beneficiary.supersedesNumber}</span>
            </Line>
          )}

          {beneficiary.endedOn === null ? null : (
            <Line label="Ended">
              <DateValue value={beneficiary.endedOn} />
              <span className="text-text-muted block text-xs">
                {beneficiary.endedReason ?? 'No reason was recorded.'}
              </span>
            </Line>
          )}
        </dl>

        {beneficiary.rejectedReason === null ? null : (
          <p className="text-text mt-4 text-sm">
            <span className="font-medium">Why it was not accepted: </span>
            {beneficiary.rejectedReason}
          </p>
        )}
      </Card>

      <BeneficiaryVerificationPanel
        beneficiaryId={beneficiary.id}
        verificationStatus={beneficiary.verificationStatus}
        documents={documents}
        canVerify={canVerify}
        canManage={canManage}
        isActive={beneficiary.status === 'active'}
      />

      <BenefitDocumentsPanel
        claimId={null}
        beneficiaryId={beneficiary.id}
        documents={documents}
        kinds={kinds}
        urls={urls}
        canAttach={canManage}
        canVerify={canVerify}
        canRemove={canManage}
        heading="Documents on this record"
      />

      {history.length === 0 ? null : (
        <Card>
          <h2 className="text-text text-sm font-semibold">
            This member&rsquo;s other beneficiary records
          </h2>
          <p className="text-text-muted mt-1 text-sm">
            A change is a new record, never an edit. The old ones are kept with their
            details and their verification, so a payment made against one stays
            explicable.
          </p>

          <ul className="divide-border/60 mt-3 divide-y">
            {history.map((row) => (
              <li key={row.id} className="min-w-0 py-2.5">
                <Link
                  href={`${ROUTES.beneficiaries}/${row.id}`}
                  className="flex min-w-0 items-center justify-between gap-3"
                >
                  <span className="min-w-0">
                    <span className="text-text block text-sm">
                      <span className="font-mono">{row.beneficiaryNumber}</span> ·{' '}
                      {row.relationshipLabel}
                      {row.isPrimary ? ' · primary' : ''}
                    </span>
                    <span className="text-text-muted block text-xs">
                      Registered <DateValue value={row.recordedOn} /> by{' '}
                      {row.recordedByLabel}
                    </span>
                  </span>
                  <span className="shrink-0 space-y-1 text-right">
                    <BeneficiaryStatusBadge status={row.status} />
                    <span className="block">
                      <BeneficiaryVerificationBadge status={row.verificationStatus} />
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Line({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-xs">{label}</dt>
      <dd className="text-text mt-0.5 text-sm">{children}</dd>
    </div>
  );
}
