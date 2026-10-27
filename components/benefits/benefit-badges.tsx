import { Badge } from '@/components/ui/badge';
import {
  BENEFICIARY_STATUS_LABELS,
  BENEFICIARY_VERIFICATION_LABELS,
  BENEFIT_CLAIM_STATUS_LABELS,
  BENEFIT_CLAIM_TYPE_LABELS,
  BENEFIT_DOCUMENT_VERIFICATION_LABELS,
  type BeneficiaryStatus,
  type BeneficiaryVerificationStatus,
  type BenefitClaimStatus,
  type BenefitClaimType,
  type BenefitDocumentVerificationStatus,
} from '@/lib/domain/benefits';

/**
 * The status pills for benefits.
 *
 * Tone never carries the meaning on its own: every badge states its status in
 * words, so each reads correctly for a colour-blind member of staff and in a
 * printout handed to a member.
 */

type Tone = 'success' | 'neutral' | 'warning' | 'danger' | 'info';

/**
 * The claim lifecycle, in tone.
 *
 * Two choices here are deliberate and worth stating.
 *
 * `assessed` and `approved` are both **amber**, not green. Each is money the
 * business has agreed something about and has not yet finished: an assessed
 * claim is waiting for an approver, an approved one is waiting for a payer.
 * Colouring either green would invite a reader to scroll past the rows that
 * still need somebody — which is the same judgement the savings module made
 * about an approved withdrawal.
 *
 * `reversed` is **danger**, where `rejected` is only neutral. A refusal is an
 * ordinary outcome. A reversal is money that went out and came back, and
 * everybody reading the register should notice it.
 */
const CLAIM_TONES: Readonly<Record<BenefitClaimStatus, Tone>> = {
  draft: 'neutral',
  submitted: 'info',
  under_verification: 'info',
  information_required: 'warning',
  assessed: 'warning',
  approved: 'warning',
  rejected: 'neutral',
  paid: 'success',
  cancelled: 'neutral',
  reversed: 'danger',
};

export function BenefitClaimStatusBadge({
  status,
}: {
  readonly status: BenefitClaimStatus;
}) {
  return <Badge tone={CLAIM_TONES[status]}>{BENEFIT_CLAIM_STATUS_LABELS[status]}</Badge>;
}

/**
 * The benefit type.
 *
 * All three neutral. A medical claim is not more or less urgent than a
 * bereavement one, and a tone that implied otherwise would be the interface
 * taking a view the business has not.
 */
export function BenefitClaimTypeBadge({ type }: { readonly type: BenefitClaimType }) {
  return <Badge tone="neutral">{BENEFIT_CLAIM_TYPE_LABELS[type]}</Badge>;
}

/**
 * Whether a beneficiary has been checked.
 *
 * `pending_verification` is **amber** and not neutral, because it is the one
 * state with a consequence: an unverified beneficiary means a bereavement
 * benefit that cannot be paid, and nobody discovers that at a convenient
 * moment. The register exists to make these findable.
 */
const VERIFICATION_TONES: Readonly<Record<BeneficiaryVerificationStatus, Tone>> = {
  pending_verification: 'warning',
  verified: 'success',
  rejected: 'danger',
};

export function BeneficiaryVerificationBadge({
  status,
}: {
  readonly status: BeneficiaryVerificationStatus;
}) {
  return (
    <Badge tone={VERIFICATION_TONES[status]}>
      {BENEFICIARY_VERIFICATION_LABELS[status]}
    </Badge>
  );
}

const BENEFICIARY_TONES: Readonly<Record<BeneficiaryStatus, Tone>> = {
  active: 'success',
  superseded: 'neutral',
  revoked: 'neutral',
};

export function BeneficiaryStatusBadge({
  status,
}: {
  readonly status: BeneficiaryStatus;
}) {
  return (
    <Badge tone={BENEFICIARY_TONES[status]}>{BENEFICIARY_STATUS_LABELS[status]}</Badge>
  );
}

/**
 * Whether a document has been checked.
 *
 * `unchecked` is amber for the reason an unverified beneficiary is: it is the
 * state that holds a claim up. A document existing is not a fact being
 * established, and this badge is where a reader sees the difference.
 */
const DOCUMENT_TONES: Readonly<Record<BenefitDocumentVerificationStatus, Tone>> = {
  unchecked: 'warning',
  verified: 'success',
  rejected: 'danger',
};

export function BenefitDocumentBadge({
  status,
}: {
  readonly status: BenefitDocumentVerificationStatus;
}) {
  return (
    <Badge tone={DOCUMENT_TONES[status]}>
      {BENEFIT_DOCUMENT_VERIFICATION_LABELS[status]}
    </Badge>
  );
}

/**
 * How much of a claim's required evidence has been checked.
 *
 * Three states rather than a count, because "2 of 3" is what a reader wants
 * and a boolean `hasEvidence` is not. Amber while anything is outstanding,
 * green only when every required kind has a checked document — which is
 * exactly the condition `assess_benefit_claim` enforces, so the pill and the
 * refusal agree.
 */
export function EvidenceProgressBadge({
  verified,
  required,
}: {
  readonly verified: number;
  readonly required: number;
}) {
  if (required === 0) {
    return <Badge tone="neutral">No documents required</Badge>;
  }

  const complete = verified >= required;

  return (
    <Badge tone={complete ? 'success' : 'warning'}>
      {complete
        ? `All ${String(required)} checked`
        : `${String(verified)} of ${String(required)} checked`}
    </Badge>
  );
}
