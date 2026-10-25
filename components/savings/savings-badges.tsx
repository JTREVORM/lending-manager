import { Badge } from '@/components/ui/badge';
import {
  CONSENT_VERIFICATION_STATUS_LABELS,
  MEMBERSHIP_CARD_STATUS_LABELS,
  SAVINGS_ACCOUNT_STATUS_LABELS,
  SAVINGS_TRANSACTION_KIND_LABELS,
  WITHDRAWAL_STATUS_LABELS,
  type ConsentVerificationStatus,
  type MembershipCardStatus,
  type SavingsAccountStatus,
  type SavingsTransactionKind,
  type WithdrawalStatus,
} from '@/lib/domain/savings';

/**
 * The status pills for savings.
 *
 * Tone never carries the meaning on its own: every badge states its status in
 * words, so each reads correctly for a colour-blind member of staff and in a
 * printout handed to a member.
 */

type Tone = 'success' | 'neutral' | 'warning' | 'danger' | 'info';

const ACCOUNT_TONES: Readonly<Record<SavingsAccountStatus, Tone>> = {
  active: 'success',
  // Not a warning. Dormant means nothing has moved for a long time, and
  // deposits are still accepted — so colouring it amber would tell a counter
  // there is something to resolve before taking the member's money.
  dormant: 'neutral',
  closed: 'neutral',
};

export function SavingsAccountStatusBadge({
  status,
}: {
  readonly status: SavingsAccountStatus;
}) {
  return (
    <Badge tone={ACCOUNT_TONES[status]}>{SAVINGS_ACCOUNT_STATUS_LABELS[status]}</Badge>
  );
}

const WITHDRAWAL_TONES: Readonly<Record<WithdrawalStatus, Tone>> = {
  pending: 'info',
  // Amber, and deliberately not green. An approved withdrawal is money the
  // business has agreed to hand over and has not handed over yet: it is
  // outstanding work, not a finished act, and a green pill would invite a
  // reader to scroll past the one row that still needs somebody at a counter.
  approved: 'warning',
  rejected: 'neutral',
  paid: 'success',
  cancelled: 'neutral',
};

export function WithdrawalStatusBadge({ status }: { readonly status: WithdrawalStatus }) {
  return (
    <Badge tone={WITHDRAWAL_TONES[status]}>{WITHDRAWAL_STATUS_LABELS[status]}</Badge>
  );
}

const KIND_TONES: Readonly<Record<SavingsTransactionKind, Tone>> = {
  deposit: 'success',
  withdrawal: 'info',
  // Both reversals are amber rather than red. A reversal is a correction
  // somebody made deliberately and recorded a reason for; red would read as a
  // fault in the record, when the record working correctly is exactly what it
  // shows.
  deposit_reversal: 'warning',
  withdrawal_reversal: 'warning',
};

export function SavingsKindBadge({ kind }: { readonly kind: SavingsTransactionKind }) {
  return <Badge tone={KIND_TONES[kind]}>{SAVINGS_TRANSACTION_KIND_LABELS[kind]}</Badge>;
}

const CONSENT_TONES: Readonly<Record<ConsentVerificationStatus, Tone>> = {
  // Amber, not neutral. An unverified acceptance is the state every Phase 1
  // record is in, and it is the reason those memberships cannot be activated
  // — so it has to look like something outstanding rather than like a detail.
  unverified: 'warning',
  verified: 'success',
  rejected: 'danger',
};

export function ConsentStatusBadge({
  status,
}: {
  readonly status: ConsentVerificationStatus;
}) {
  return (
    <Badge tone={CONSENT_TONES[status]}>
      {CONSENT_VERIFICATION_STATUS_LABELS[status]}
    </Badge>
  );
}

const CARD_TONES: Readonly<Record<MembershipCardStatus, Tone>> = {
  active: 'success',
  superseded: 'neutral',
  cancelled: 'danger',
};

export function MembershipCardStatusBadge({
  status,
}: {
  readonly status: MembershipCardStatus;
}) {
  return <Badge tone={CARD_TONES[status]}>{MEMBERSHIP_CARD_STATUS_LABELS[status]}</Badge>;
}
