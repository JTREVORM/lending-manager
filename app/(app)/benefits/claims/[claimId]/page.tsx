import { DeathVerification } from '@/components/policy-update/death-verification';
import { HeartHandshake } from 'lucide-react';
import { notFound } from 'next/navigation';

import { AssessmentSnapshotPanel } from '@/components/benefits/assessment-snapshot-panel';
import { BenefitDocumentsPanel } from '@/components/benefits/benefit-documents-panel';
import { BenefitPaymentPanel } from '@/components/benefits/benefit-payment-panel';
import { ClaimDecisionPanel } from '@/components/benefits/claim-decision-panel';
import { ClaimEligibilityPanel } from '@/components/benefits/claim-eligibility-panel';
import { ClaimFactsPanel } from '@/components/benefits/claim-facts-panel';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { mintBenefitKey } from '@/lib/benefits/actions';
import {
  getAssessmentSnapshot,
  getBenefitClaim,
  getBenefitPaymentForClaim,
  getClaimEligibility,
  listBenefitDocumentKinds,
  listClaimDocuments,
} from '@/lib/data/benefits';
import { getMembership, getMembershipPolicy } from '@/lib/data/membership';
import {
  BENEFIT_RECIPIENT_KIND_LABELS,
  benefitRecipientKindFor,
} from '@/lib/domain/benefits';
import { signedBenefitDocumentUrl } from '@/lib/storage/benefit-documents';

export const metadata = { title: 'Benefit claim' };

/**
 * One claim: its facts, its evidence, why it can or cannot be assessed, the
 * frozen assessment, and the payment.
 *
 * ## Six reads, and every one as the caller
 *
 * Nothing on this page uses a privileged client, so each panel appears or
 * disappears according to the policies rather than according to a capability
 * check written here. `getAssessmentSnapshot` returns `null` for a
 * Secretary/Treasurer — an assessment is an officer's working record — and the
 * panel then renders nothing at all rather than saying "restricted", because
 * on a bereavement claim that sentence would itself disclose that the business
 * has identified a payee.
 *
 * ## The document URLs are signed here
 *
 * One signature per document, minted as the caller with a sixty-second life.
 * Signing them in the page rather than behind a client-side action is what
 * keeps the storage read policy in the loop: a reader who may not fetch an
 * object gets no URL rather than a URL that fails.
 *
 * ## The payment key is minted on render
 *
 * `mintBenefitKey()` runs server-side as this page renders, so the key is
 * fixed before anybody can tap twice and both taps carry it.
 */
export default async function BenefitClaimPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly claimId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await guardPermission(ROUTES.benefitClaims, 'benefits:view');
  const { claimId } = await params;
  const query = await searchParams;

  const claim = await getBenefitClaim(claimId);

  if (claim === null) notFound();

  const canAssess = contextCan(context, 'benefits:assess');
  const canApprove = contextCan(context, 'benefits:approve');
  const canPay = contextCan(context, 'benefits:pay');
  const canClaim = contextCan(context, 'benefits:claim');
  const canReverse = contextCan(context, 'savings:reverse');

  const [documents, kinds, eligibility, snapshot, payment, idempotencyKey, membership] =
    await Promise.all([
      listClaimDocuments(claim.id),
      listBenefitDocumentKinds(claim.claimType),
      canAssess || canApprove ? getClaimEligibility(claim.id) : Promise.resolve(null),
      getAssessmentSnapshot(claim.id),
      getBenefitPaymentForClaim(claim.id),
      mintBenefitKey(),
      getMembership(claim.membershipId),
    ]);

  const policy =
    membership === null ? null : await getMembershipPolicy(membership.policyVersionId);

  // One signature per document, each sixty seconds long. A document whose
  // object cannot be signed for this reader is listed without a link, which
  // is the honest outcome: the row exists and they may not fetch it.
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

  const recipientKind = benefitRecipientKindFor(claim.claimType);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Membership Benefits"
        icon={HeartHandshake}
        title={`Claim ${claim.claimNumber}`}
        description={`${claim.memberName} · ${claim.membershipNumber}`}
        back={{ href: ROUTES.benefitClaims, label: 'Benefit claims' }}
      />

      {query.opened === '1' ? (
        <Alert tone="success" title="Claim opened as a draft">
          Attach the evidence, then submit it. Submitting freezes the facts, which is what
          makes the assessment reviewable.
        </Alert>
      ) : null}

      {claim.claimType !== 'medical' ? (
        <DeathVerification
          claimId={claim.id}
          membershipId={claim.membershipId}
          canRecord={
            canClaim &&
            ['draft', 'submitted', 'under_verification', 'information_required'].includes(
              claim.status,
            )
          }
        />
      ) : null}
      <ClaimFactsPanel
        claim={claim}
        minimumAdmissionDays={policy?.medicalBenefitMinAdmissionDays ?? null}
      />

      <ClaimEligibilityPanel failures={eligibility} />

      <BenefitDocumentsPanel
        claimId={claim.id}
        beneficiaryId={null}
        documents={documents}
        kinds={kinds}
        urls={urls}
        canAttach={canClaim}
        canVerify={canAssess}
        canRemove={canClaim}
      />

      <AssessmentSnapshotPanel snapshot={snapshot} />

      <ClaimDecisionPanel
        claim={claim}
        canClaim={canClaim}
        canAssess={canAssess}
        canApprove={canApprove}
        viewerLabel={context.fullName}
      />

      <BenefitPaymentPanel
        claim={claim}
        payment={payment}
        idempotencyKey={idempotencyKey}
        canPay={canPay}
        canReverse={canReverse}
        recipientName={
          snapshot === null
            ? null
            : recipientKind === 'beneficiary'
              ? snapshot.beneficiaryName
              : claim.memberName
        }
        recipientKindLabel={BENEFIT_RECIPIENT_KIND_LABELS[recipientKind]}
      />
    </div>
  );
}
