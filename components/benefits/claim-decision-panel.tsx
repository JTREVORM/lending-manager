'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import {
  approveBenefitClaimAction,
  assessBenefitClaimAction,
  beginVerificationAction,
  cancelBenefitClaimAction,
  rejectBenefitClaimAction,
  requestInformationAction,
  submitBenefitClaimAction,
  type BenefitActionResult,
} from '@/lib/benefits/actions';
import { Money } from '@/components/ui/money';
import type { BenefitClaimSummary } from '@/lib/data/benefits';
import type { UgxAmount } from '@/lib/domain/money';

/**
 * What can be done to this claim, by this person, now.
 *
 * ## The buttons are a reflection of the state machine, not a second copy
 *
 * `benefit_claim_transition_allowed` decides which moves exist, and every
 * function here refuses a move it does not permit. This panel shows only the
 * moves that are both permitted from the claim's current status and within
 * the reader's capabilities — so nobody is offered a button that will refuse
 * them, and nobody can reach a move by guessing a form.
 *
 * ## Separation of duties is shown, not only enforced
 *
 * `approve_benefit_claim` refuses an approval from whoever assessed the claim,
 * by profile id **and** by actor label, so it holds even for an Owner who
 * holds both capabilities and even when the assessor's account has since been
 * archived. The panel says so where an approver can see it, because a control
 * that surprises people gets worked around.
 *
 * ## There is no amount field on approval
 *
 * Deliberately, and the schema has none either. An approver agrees to the
 * assessed figure or refuses the claim; a partial approval would be a second
 * assessment performed by somebody who did not assess, and
 * `approve_benefit_claim` refuses one outright. Where an approver thinks the
 * figure is wrong, the claim goes back with a reason.
 */
export function ClaimDecisionPanel({
  claim,
  canClaim,
  canAssess,
  canApprove,
  viewerLabel,
}: {
  readonly claim: BenefitClaimSummary;
  readonly canClaim: boolean;
  readonly canAssess: boolean;
  readonly canApprove: boolean;
  /** The reader's own name, for the separation-of-duties notice. */
  readonly viewerLabel: string;
}) {
  const status = claim.status;

  const canSubmit = canClaim && status === 'draft';
  const canBeginVerification = canAssess && status === 'submitted';
  const canRequestInformation =
    canAssess && (status === 'submitted' || status === 'under_verification');
  const canAssessNow =
    canAssess &&
    (status === 'submitted' ||
      status === 'under_verification' ||
      status === 'information_required');
  const canApproveNow = canApprove && status === 'assessed';
  const canReject =
    canAssess &&
    (status === 'submitted' ||
      status === 'under_verification' ||
      status === 'information_required' ||
      status === 'assessed');
  const canCancel =
    canClaim &&
    (status === 'draft' ||
      status === 'submitted' ||
      status === 'under_verification' ||
      status === 'information_required');

  const anything =
    canSubmit ||
    canBeginVerification ||
    canRequestInformation ||
    canAssessNow ||
    canApproveNow ||
    canReject ||
    canCancel;

  if (!anything) return null;

  // The database decides this by profile id and by label; the label is what a
  // screen has to hand. A false negative here only costs a notice, and the
  // refusal is the database's either way.
  const viewerAssessedIt =
    claim.assessedByLabel !== null && claim.assessedByLabel === viewerLabel;

  return (
    <Card>
      <h2 className="text-text text-sm font-semibold">What happens next</h2>

      <div className="mt-3 min-w-0 space-y-4">
        {canSubmit ? (
          <OneButtonAction
            claimId={claim.id}
            action={submitBenefitClaimAction}
            label="Submit the claim"
            busyLabel="Submitting…"
            explanation="Submitting freezes the facts — the hospital, the bill, the admission times, the event date. Attach the evidence first if you have it; it can still be attached afterwards."
          />
        ) : null}

        {canBeginVerification ? (
          <OneButtonAction
            claimId={claim.id}
            action={beginVerificationAction}
            label="Take it up for checking"
            busyLabel="Taking it up…"
            explanation="Puts the claim in your hands, so the register shows who is working on it."
          />
        ) : null}

        {canAssessNow ? (
          <NoteAction
            claimId={claim.id}
            action={assessBenefitClaimAction}
            label="Assess the claim"
            busyLabel="Assessing…"
            noteLabel="Your note on this assessment (optional)"
            noteRequired={false}
            noteHint="What you checked, and anything the approver should know. It is kept with the frozen assessment."
            explanation="The amount is worked out by the database from this claim's own policy version, under a lock on the membership, against whatever the member has already claimed this year. You are not entering a figure."
            tone="primary"
          />
        ) : null}

        {canApproveNow ? (
          <div className="min-w-0">
            {viewerAssessedIt ? (
              <Alert tone="warning" title="You assessed this claim">
                Approval has to come from somebody else. That is refused in the database
                rather than hidden here, by name as well as by account, so it holds even
                for an account that has since been archived.
              </Alert>
            ) : (
              <NoteAction
                claimId={claim.id}
                action={approveBenefitClaimAction}
                label={
                  claim.assessedAmount === null
                    ? 'Approve the claim'
                    : 'Approve the assessed amount'
                }
                busyLabel="Approving…"
                noteLabel="Your note on this approval (optional)"
                noteRequired={false}
                noteHint="Kept on the claim. The approval itself is the assessed figure — there is nothing to adjust."
                explanation={
                  claim.assessedAmount === null
                    ? 'Approving agrees to the assessed figure exactly.'
                    : undefined
                }
                amount={claim.assessedAmount}
                tone="primary"
              />
            )}
          </div>
        ) : null}

        {canRequestInformation ? (
          <NoteAction
            claimId={claim.id}
            action={requestInformationAction}
            label="Ask for more information"
            busyLabel="Recording…"
            noteLabel="What is missing?"
            noteRequired
            noteHint="The member or the officer who opened the claim will be asked for exactly this, so be specific."
            tone="secondary"
          />
        ) : null}

        {canReject ? (
          <NoteAction
            claimId={claim.id}
            action={rejectBenefitClaimAction}
            label="Refuse the claim"
            busyLabel="Recording…"
            noteLabel="Why is it refused?"
            noteRequired
            noteHint="This is the reason the member is given, and it stays on the record. A refusal with no reason is a dead end for them."
            tone="danger"
          />
        ) : null}

        {canCancel ? (
          <NoteAction
            claimId={claim.id}
            action={cancelBenefitClaimAction}
            label="Withdraw the claim"
            busyLabel="Recording…"
            noteLabel="Why is it being withdrawn?"
            noteRequired
            noteHint="A claim recorded in error is withdrawn rather than deleted, and a new one is opened. Nothing is removed from the record."
            tone="secondary"
          />
        ) : null}
      </div>
    </Card>
  );
}

type ClaimAction = (
  previous: BenefitActionResult | undefined,
  formData: FormData,
) => Promise<BenefitActionResult>;

function OneButtonAction({
  claimId,
  action,
  label,
  busyLabel,
  explanation,
}: {
  readonly claimId: string;
  readonly action: ClaimAction;
  readonly label: string;
  readonly busyLabel: string;
  readonly explanation: string;
}) {
  const [result, submit, pending] = useActionState<
    BenefitActionResult | undefined,
    FormData
  >(action, undefined);

  return (
    <form action={submit} className="min-w-0 space-y-2">
      <input type="hidden" name="claimId" value={claimId} />
      <p className="text-text-muted text-sm">{explanation}</p>
      {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}
      <Button type="submit" disabled={pending}>
        {pending ? busyLabel : label}
      </Button>
    </form>
  );
}

/**
 * An action that carries a note, revealed on request.
 *
 * Collapsed until somebody chooses it, because four forms open at once on a
 * phone is a screen nobody can read — and because a refusal field sitting open
 * beside an approve button invites the wrong one.
 */
function NoteAction({
  claimId,
  action,
  label,
  busyLabel,
  noteLabel,
  noteRequired,
  noteHint,
  explanation,
  amount,
  tone = 'secondary',
}: {
  readonly claimId: string;
  readonly action: ClaimAction;
  readonly label: string;
  readonly busyLabel: string;
  readonly noteLabel: string;
  readonly noteRequired: boolean;
  readonly noteHint: string;
  readonly explanation?: string;
  readonly amount?: UgxAmount | null;
  readonly tone?: 'primary' | 'secondary' | 'danger';
}) {
  const [open, setOpen] = useState(false);

  const [result, submit, pending] = useActionState<
    BenefitActionResult | undefined,
    FormData
  >(action, undefined);

  if (!open) {
    return (
      <div className="min-w-0 space-y-2">
        {explanation === undefined ? null : (
          <p className="text-text-muted text-sm">{explanation}</p>
        )}
        <Button
          type="button"
          variant={tone}
          onClick={() => {
            setOpen(true);
          }}
        >
          {amount === undefined || amount === null ? (
            label
          ) : (
            <>
              {label} · <Money amount={amount} />
            </>
          )}
        </Button>
      </div>
    );
  }

  return (
    <form
      action={submit}
      className="border-border min-w-0 space-y-3 rounded-lg border p-3"
    >
      <input type="hidden" name="claimId" value={claimId} />

      {explanation === undefined ? null : (
        <p className="text-text-muted text-sm">{explanation}</p>
      )}

      {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}

      <Field
        label={noteLabel}
        name="note"
        type="text"
        autoComplete="off"
        required={noteRequired}
        autoFocus
        error={result?.fieldErrors?.note?.[0]}
        hint={noteHint}
      />

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={tone} disabled={pending}>
          {pending ? busyLabel : label}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => {
            setOpen(false);
          }}
        >
          Never mind
        </Button>
      </div>
    </form>
  );
}
