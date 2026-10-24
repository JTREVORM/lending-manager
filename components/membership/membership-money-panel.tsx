import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import { RowLink } from '@/components/ui/row-link';
import {
  ConsentStatusBadge,
  SavingsAccountStatusBadge,
} from '@/components/savings/savings-badges';
import { ROUTES } from '@/config/app';
import { PAYMENT_METHOD_LABELS } from '@/lib/domain/payment';
import {
  CONSENT_METHOD_LABELS,
  MEMBERSHIP_FEE_STATUS_LABELS,
} from '@/lib/domain/savings';
import type {
  ConsentRecord,
  FeeReceiptSummary,
  SavingsAccountSummary,
} from '@/lib/data/savings';

/**
 * The money and the evidence behind one membership: the fee, the acceptance
 * and the savings account.
 *
 * This replaces the Phase 1 panel that said savings and fees were built in a
 * later phase. They are built now, so the honest thing is to show them — and
 * where a membership has none of the three, to say which is missing rather
 * than showing a zero.
 *
 * ## The fee and the acceptance are the activation preconditions
 *
 * A membership reaches `active` only when the registration fee has reached the
 * ledger unreversed **and** a verified acceptance of its own policy version
 * exists. Both are enforced in PostgreSQL, above the trusted-path exemption.
 * So when a membership is still `pending`, this panel is the screen that says
 * which of the two is outstanding — which is the question somebody looking at
 * a pending membership actually has.
 *
 * ## A typed name is shown as what it is
 *
 * A Phase 1 acceptance carries `legacy_typed_name` and reads `Not verified`.
 * It is not hidden and not quietly relabelled: the memberships that hold one
 * cannot be activated until real consent is taken, and a badge that said
 * otherwise would be the software asserting something it cannot support.
 *
 * ## No digest reaches this component
 *
 * `listMembershipConsent` does not select `evidence_digest`. A digest of a
 * one-time code or a signature path proves nothing to a person reading the
 * record and would sit in a response body, a cache and a debug log for no
 * gain.
 */
export function MembershipMoneyPanel({
  receipt,
  consent,
  savingsAccount,
  policyVersion,
  membershipStatus,
  registrationFee,
}: {
  readonly receipt: FeeReceiptSummary | null;
  readonly consent: readonly ConsentRecord[];
  readonly savingsAccount: SavingsAccountSummary | null;
  readonly policyVersion: string;
  readonly membershipStatus: string;
  readonly registrationFee: number;
}) {
  // The acceptance that counts is the one for the version this member is held
  // to, and only if the database verified it. An acceptance of an earlier
  // version does not activate anybody.
  const governingConsent =
    consent.find(
      (record) =>
        record.policyVersion === policyVersion &&
        record.verificationStatus === 'verified',
    ) ?? null;

  const feeIsPosted = receipt !== null && receipt.status === 'posted';

  return (
    <div className="min-w-0 space-y-3">
      {/* --- What is outstanding, for a pending membership -------------- */}
      {membershipStatus === 'pending' ? (
        <Card>
          <h3 className="text-text text-sm font-semibold">
            Before this membership can be activated
          </h3>
          <ul className="mt-2 space-y-1.5 text-sm">
            <Requirement met={feeIsPosted}>
              {feeIsPosted ? (
                <>The registration fee has been taken and posted to the ledger.</>
              ) : (
                <>
                  The registration fee of <Money amount={registrationFee} /> has not been
                  posted.
                </>
              )}
            </Requirement>
            <Requirement met={governingConsent !== null}>
              {governingConsent === null ? (
                <>
                  There is no verified acceptance of policy version {policyVersion}.
                  {consent.length > 0
                    ? ' An acceptance exists but has not been verified — a typed name is not consent.'
                    : ''}
                </>
              ) : (
                <>The member&rsquo;s acceptance of version {policyVersion} is verified.</>
              )}
            </Requirement>
          </ul>
          <p className="text-text-muted mt-2 text-xs">
            Both are enforced inside the database, so a membership cannot be activated
            without them however the attempt is made.
          </p>
        </Card>
      ) : null}

      {/* --- The registration fee --------------------------------------- */}
      <Card>
        <h3 className="text-text text-sm font-semibold">Registration fee</h3>

        {receipt === null ? (
          <p className="text-text-muted mt-1 text-sm">
            No registration fee has been recorded against this membership.
          </p>
        ) : (
          <dl className="mt-2 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Figure label="Amount">
              <Money
                amount={receipt.amount}
                weight="semibold"
                struck={receipt.status === 'reversed'}
              />
            </Figure>
            <Figure label="Receipt">
              <span className="font-mono text-sm">{receipt.receiptNumber}</span>
              <span className="text-text-muted block text-xs">
                {MEMBERSHIP_FEE_STATUS_LABELS[receipt.status]}
              </span>
            </Figure>
            <Figure label="Received">
              <DateValue value={receipt.businessDate} />
              <span className="text-text-muted block text-xs">
                {PAYMENT_METHOD_LABELS[receipt.paymentMethod]}
                {receipt.externalReference === null
                  ? ''
                  : ` · ${receipt.externalReference}`}
              </span>
            </Figure>
            <Figure label="Taken by">
              <span className="text-sm break-words">{receipt.recordedByLabel}</span>
            </Figure>
            {receipt.reversalReason === null ? null : (
              <div className="min-w-0 sm:col-span-2 lg:col-span-4">
                <dt className="text-text-muted text-xs">Reversed</dt>
                <dd className="text-text mt-0.5 text-sm break-words">
                  {receipt.reversalReason}
                </dd>
              </div>
            )}
          </dl>
        )}
      </Card>

      {/* --- The acceptance --------------------------------------------- */}
      <Card>
        <h3 className="text-text text-sm font-semibold">Acceptance of the terms</h3>

        {consent.length === 0 ? (
          <p className="text-text-muted mt-1 text-sm">
            No acceptance has been recorded. A membership cannot be activated without a
            verified one.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {consent.map((record) => (
              <li key={record.id} className="border-border min-w-0 rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-text text-sm font-medium break-words">
                      Version {record.policyVersion}
                      {record.policyVersion === policyVersion ? (
                        <span className="text-text-muted ml-1.5 text-xs">
                          (the version this member is held to)
                        </span>
                      ) : null}
                    </p>
                    <p className="text-text-muted mt-0.5 text-xs">
                      {CONSENT_METHOD_LABELS[record.consentMethod]}
                    </p>
                  </div>
                  <ConsentStatusBadge status={record.verificationStatus} />
                </div>
                <dl className="mt-2 grid min-w-0 gap-2 text-xs sm:grid-cols-3">
                  <div className="min-w-0">
                    <dt className="text-text-muted">Signed as</dt>
                    <dd className="text-text break-words">{record.signatureName}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-text-muted">Accepted</dt>
                    <dd className="text-text">
                      <DateValue value={record.acceptedAt} variant="datetime" />
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-text-muted">Verified by</dt>
                    <dd className="text-text break-words">
                      {record.verifiedByLabel ?? '—'}
                    </dd>
                  </div>
                </dl>
                {record.verificationStatus === 'unverified' ? (
                  <p className="text-text-muted mt-2 text-xs">
                    This record was taken before verifiable consent was required. It
                    carries a typed name, which anybody with the form could have typed, so
                    it does not satisfy activation.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* --- Savings ---------------------------------------------------- */}
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-text text-sm font-semibold">Savings</h3>
          {savingsAccount === null ? null : (
            <SavingsAccountStatusBadge status={savingsAccount.status} />
          )}
        </div>

        {savingsAccount === null ? (
          <p className="text-text-muted mt-1 text-sm">
            No savings account has been opened for this membership. One is opened when a
            member is enrolled, and it cannot be opened while the savings rules are
            undecided.
          </p>
        ) : (
          <>
            <dl className="mt-2 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Figure label="Balance">
                {/* What the business owes this member. There is no stored
                    balance anywhere in this schema for it to disagree with. */}
                <Money amount={savingsAccount.balance} weight="semibold" />
              </Figure>
              <Figure label="Account">
                <RowLink
                  href={`${ROUTES.savings}/${savingsAccount.id}`}
                  className="text-accent font-mono text-sm underline-offset-2 hover:underline"
                >
                  {savingsAccount.accountNumber}
                </RowLink>
              </Figure>
              <Figure label="Paid in, all time">
                <Money amount={savingsAccount.totalDeposited} />
              </Figure>
              <Figure label="Last movement">
                <DateValue value={savingsAccount.lastTransactionOn} />
              </Figure>
            </dl>
            <p className="text-text-muted mt-2 text-xs">
              A member&rsquo;s savings are a liability of the business, not its income.
              The figure above is what it owes them.
            </p>
          </>
        )}
      </Card>
    </div>
  );
}

function Requirement({
  met,
  children,
}: {
  readonly met: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <li className="flex min-w-0 items-start gap-2">
      {/* A word, not only a colour or a glyph: this list is read by somebody
          deciding whether a member can join today, and it has to survive a
          printout and a colour-blind reader. */}
      <span
        className={
          met
            ? 'text-success shrink-0 text-xs font-semibold uppercase'
            : 'text-warning shrink-0 text-xs font-semibold uppercase'
        }
      >
        {met ? 'Done' : 'Needed'}
      </span>
      <span className="text-text min-w-0 break-words">{children}</span>
    </li>
  );
}

function Figure({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-xs">{label}</dt>
      <dd className="text-text mt-0.5 tabular-nums">{children}</dd>
    </div>
  );
}
