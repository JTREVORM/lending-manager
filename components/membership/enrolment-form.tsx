'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { useFocusWhen } from '@/components/ui/focus-on-appear';
import { Money } from '@/components/ui/money';
import { ROUTES } from '@/config/app';
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  isMobileMoney,
  requiresExternalReference,
  type PaymentMethod,
} from '@/lib/domain/payment';
import { formatUgx, toUgx } from '@/lib/domain/money';
import {
  CONSENT_METHOD_DESCRIPTIONS,
  CONSENT_METHOD_LABELS,
  type ConsentMethod,
} from '@/lib/domain/savings';
import { enrolMemberAction, type MembershipActionResult } from '@/lib/membership/actions';
import type { WitnessCandidate } from '@/lib/data/savings';

/**
 * Enrolling a client as a member.
 *
 * ## One submission, one transaction
 *
 * Everything on this form goes to `enrol_member` in a single call: the
 * membership, the registration fee and its journal entry, the verified
 * acceptance, the activation, the savings account and an optional first
 * deposit. It all happens, or none of it does.
 *
 * A wizard would be easier to build and would create two states this business
 * cannot afford: a member who paid and is not active, and a member who is
 * active and did not pay. Neither exists here, because there is no point
 * between them at which the work can be left.
 *
 * ## Consent is the part worth reading
 *
 * Phase 1 recorded a typed signature name and a typed witness name, and said
 * in its own migration what that was worth: a typed name is not consent,
 * because anybody with the form can type anybody's name. So this form collects
 * evidence the database can check, and the database — not this form — decides
 * whether it holds.
 *
 * **Witnessing is the only method available at this screen**, and that is a
 * consequence of the evidence rather than a simplification. Each of the other
 * three needs something that cannot exist yet, or somebody who is not at the
 * counter:
 *
 *   - a **one-time code** is bound to a membership and a policy version, and
 *     the membership does not exist until this form is submitted;
 *   - a **signed document** has to be uploaded under that same
 *     not-yet-existing membership's path, which is what makes "this member's
 *     own signature" expressible as a storage policy;
 *   - a **member portal** confirmation needs the member's own signed-in
 *     session, which is the whole point of it and is not something a counter
 *     can do on their behalf.
 *
 * All three are offered on the membership record afterwards, where the
 * membership exists. A client who wants to join by code or by signature has
 * their application taken first — which creates the pending membership — and
 * the fee and the acceptance are recorded against it.
 *
 * So the witness must be a named, active member of staff who is **not** the
 * person recording the enrolment. The picker below excludes the current user
 * for that reason, and the guard refuses them again.
 *
 * ## The fee amount is not a field
 *
 * It comes from the membership policy version in force, inside
 * `enrol_member`. A form that could send it could enrol somebody for a
 * shilling, and a member who joins in March would stop keeping March's terms
 * when the business changes the fee in June. The figure is *shown* so a
 * counter knows what to collect.
 *
 * ## The idempotency key
 *
 * Minted server-side when this form renders and carried as a hidden field. A
 * double tap, a lost response or a back-button resubmission all send the same
 * key, and the database returns the membership that already exists rather than
 * enrolling twice and charging twice. See ADR-030.
 */
export function EnrolmentForm({
  clientId,
  clientName,
  clientNumber,
  registrationFee,
  monthlySavingsMinimum,
  witnesses,
  idempotencyKey,
}: {
  readonly clientId: string;
  readonly clientName: string;
  readonly clientNumber: string;
  readonly registrationFee: number;
  readonly monthlySavingsMinimum: number;
  readonly witnesses: readonly WitnessCandidate[];
  readonly idempotencyKey: string;
}) {
  const router = useRouter();

  const [result, submit, pending] = useActionState<
    MembershipActionResult | undefined,
    FormData
  >(async (previous, formData) => {
    const next = await enrolMemberAction(previous, formData);

    if (next.ok && next.membershipId !== undefined) {
      // `replace`, not `push`: the form's URL must not stay in history, or the
      // back button offers to enrol the same client again. The destination
      // reads the membership from the database and shows the membership
      // number, the receipt and the savings account — none of which this form
      // can state authoritatively.
      router.replace(`${ROUTES.membership}/${next.membershipId}?enrolled=1`);
    }

    return next;
  }, undefined);

  // Witnessing is the only method whose evidence can exist at this point in
  // the work. See the note at the top of this file: the other three each need
  // the membership to exist first, and the membership is what this form
  // creates.
  const consentMethod: ConsentMethod = 'witnessed_in_branch';

  const [signatureName, setSignatureName] = useState(clientName);
  const [witnessProfileId, setWitnessProfileId] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [depositText, setDepositText] = useState('');
  const [depositReference, setDepositReference] = useState('');
  const [notes, setNotes] = useState('');
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useFocusWhen<HTMLDivElement>(confirming);

  const parsedDeposit = /^\d+$/.test(depositText.replace(/[\s,]/g, ''))
    ? Number(depositText.replace(/[\s,]/g, ''))
    : null;

  const referenceMissing = requiresExternalReference(method) && reference.trim() === '';
  const depositReferenceMissing =
    parsedDeposit !== null &&
    requiresExternalReference(method) &&
    depositReference.trim() === '';

  const canContinue =
    signatureName.trim().length >= 2 &&
    !referenceMissing &&
    !depositReferenceMissing &&
    witnessProfileId !== '' &&
    !pending;

  const total = registrationFee + (parsedDeposit ?? 0);

  if (result?.ok === true) {
    return (
      <Alert tone="success">
        <span className="font-medium">{result.message}</span> Opening the membership…
      </Alert>
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      <form action={submit} className="min-w-0 space-y-4">
        <input type="hidden" name="clientId" value={clientId} />
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

        {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}

        {/* --- Step one -------------------------------------------------- */}
        {confirming ? null : (
          <Card>
            <dl className="mb-4 grid min-w-0 gap-3 sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-text-muted text-sm">Client</dt>
                <dd className="text-text font-medium break-words">
                  {clientName}{' '}
                  <span className="text-text-muted font-mono text-sm">
                    {clientNumber}
                  </span>
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-text-muted text-sm">Registration fee</dt>
                <dd className="text-text font-semibold tabular-nums">
                  <Money amount={toUgx(registrationFee)} />
                </dd>
                <dd className="text-text-muted text-xs">
                  From the membership policy in force, not typed here
                </dd>
              </div>
            </dl>

            {/* --- Consent ------------------------------------------------ */}
            <input type="hidden" name="consentMethod" value={consentMethod} />
            <div className="border-border min-w-0 rounded-lg border p-3">
              <p className="text-text text-sm font-medium">
                {CONSENT_METHOD_LABELS[consentMethod]}
              </p>
              <p className="text-text-muted mt-0.5 text-xs">
                {CONSENT_METHOD_DESCRIPTIONS[consentMethod]}
              </p>
              <p className="text-text-muted mt-2 text-xs">
                A one-time code, a signed document or a confirmation in the member&rsquo;s
                own portal are all stronger, and all need the membership to exist first —
                a code is bound to a membership, and a signature is stored under one. To
                use any of them, take the application first and record the fee and the
                acceptance against the pending membership.
              </p>
            </div>

            <div className="mt-4 space-y-4">
              <Field
                label="The name the member signed as"
                name="signatureName"
                type="text"
                autoComplete="off"
                required
                value={signatureName}
                onChange={(event) => {
                  setSignatureName(event.target.value);
                }}
                error={result?.fieldErrors?.signatureName?.[0]}
                hint="Prefilled from the client record. Change it if they signed differently — it is how a later reader knows which name was used."
              />

              <div className="min-w-0">
                <label
                  htmlFor="witness"
                  className="text-text mb-1 block text-sm font-medium"
                >
                  Who witnessed it?
                </label>
                <select
                  id="witness"
                  name="witnessProfileId"
                  required
                  value={witnessProfileId}
                  onChange={(event) => {
                    setWitnessProfileId(event.target.value);
                  }}
                  className="border-border bg-surface text-text focus-visible:outline-accent min-h-11 w-full rounded-lg border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <option value="">Choose a member of staff…</option>
                  {witnesses.map((witness) => (
                    <option key={witness.profileId} value={witness.profileId}>
                      {witness.fullName}
                    </option>
                  ))}
                </select>
                <p className="text-text-muted mt-1 text-xs">
                  You are not in this list: a witness cannot be the person recording the
                  enrolment, which is what makes witnessing mean anything.
                </p>
                {result?.fieldErrors?.witnessProfileId?.[0] === undefined ? null : (
                  <p className="text-danger mt-1 text-xs">
                    {result.fieldErrors.witnessProfileId[0]}
                  </p>
                )}
              </div>
            </div>

            {/* --- The money ---------------------------------------------- */}
            <div className="border-border mt-4 border-t pt-4">
              <fieldset className="min-w-0">
                <legend className="text-text mb-2 text-sm font-medium">
                  How was the fee paid?
                </legend>
                <div className="flex min-w-0 flex-wrap gap-2">
                  {PAYMENT_METHODS.map((candidate) => (
                    <label
                      key={candidate}
                      className={`focus-within:outline-accent inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm focus-within:outline-2 focus-within:outline-offset-2 ${
                        method === candidate
                          ? 'border-accent bg-accent-surface text-accent'
                          : 'border-border text-text'
                      }`}
                    >
                      <input
                        type="radio"
                        name="paymentMethod"
                        value={candidate}
                        checked={method === candidate}
                        onChange={() => {
                          setMethod(candidate);
                        }}
                        className="sr-only"
                      />
                      {PAYMENT_METHOD_LABELS[candidate]}
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="mt-4 space-y-4">
                {requiresExternalReference(method) ? (
                  <Field
                    label={
                      isMobileMoney(method)
                        ? 'Transaction reference for the fee'
                        : 'Transfer reference for the fee'
                    }
                    name="externalReference"
                    type="text"
                    autoComplete="off"
                    autoCapitalize="characters"
                    required
                    value={reference}
                    onChange={(event) => {
                      setReference(event.target.value);
                    }}
                    error={result?.fieldErrors?.externalReference?.[0]}
                  />
                ) : (
                  <p className="text-text-muted text-sm">
                    A cash payment has no network reference. Its receipt number is its
                    reference.
                  </p>
                )}

                <Field
                  label="First savings deposit (optional)"
                  name="initialDeposit"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={depositText}
                  onChange={(event) => {
                    setDepositText(event.target.value);
                  }}
                  error={result?.fieldErrors?.initialDeposit?.[0]}
                  hint={`If the member is paying into savings today as well. ${formatUgx(toUgx(monthlySavingsMinimum))} is the monthly minimum.`}
                />

                {parsedDeposit !== null && requiresExternalReference(method) ? (
                  <Field
                    label="Transaction reference for the deposit"
                    name="depositReference"
                    type="text"
                    autoComplete="off"
                    autoCapitalize="characters"
                    required
                    value={depositReference}
                    onChange={(event) => {
                      setDepositReference(event.target.value);
                    }}
                    error={result?.fieldErrors?.depositReference?.[0]}
                    hint="A second movement needs its own reference — the fee and the deposit are two postings."
                  />
                ) : null}

                <Field
                  label="Note (optional)"
                  name="notes"
                  type="text"
                  autoComplete="off"
                  value={notes}
                  onChange={(event) => {
                    setNotes(event.target.value);
                  }}
                  error={result?.fieldErrors?.notes?.[0]}
                />
              </div>
            </div>

            <div className="border-border mt-4 min-w-0 rounded-lg border p-3">
              <p className="text-text text-sm font-medium tabular-nums">
                Collect <Money amount={toUgx(total)} />
              </p>
              <p className="text-text-muted mt-0.5 text-xs tabular-nums">
                <Money amount={toUgx(registrationFee)} /> registration fee
                {parsedDeposit === null ? null : (
                  <>
                    {' and '}
                    <Money amount={toUgx(parsedDeposit)} /> into savings
                  </>
                )}
                . The fee is income; the deposit is money the business will owe the
                member.
              </p>
            </div>

            <div className="mt-4">
              <Button
                type="button"
                disabled={!canContinue}
                onClick={() => {
                  setConfirming(true);
                }}
              >
                Continue
              </Button>
            </div>
          </Card>
        )}

        {/* --- Step two: confirm ---------------------------------------- */}
        {confirming ? (
          <Card ref={confirmRef} tabIndex={-1} aria-labelledby="confirm-enrol-heading">
            {/* Step one is unmounted while this step is shown, and an
                unmounted input is not submitted — so every value is carried
                here. They are the same state step one edits, so the two
                cannot disagree. */}
            <input type="hidden" name="consentMethod" value={consentMethod} />
            <input type="hidden" name="signatureName" value={signatureName} />
            <input type="hidden" name="witnessProfileId" value={witnessProfileId} />
            <input type="hidden" name="paymentMethod" value={method} />
            {requiresExternalReference(method) ? (
              <input type="hidden" name="externalReference" value={reference} />
            ) : null}
            <input type="hidden" name="initialDeposit" value={depositText} />
            {parsedDeposit !== null && requiresExternalReference(method) ? (
              <input type="hidden" name="depositReference" value={depositReference} />
            ) : null}
            <input type="hidden" name="notes" value={notes} />

            <h3 id="confirm-enrol-heading" className="text-text text-lg font-semibold">
              Confirm this enrolment
            </h3>
            <p className="text-text-muted mt-1 text-sm">
              Recording this takes the fee, posts it to the ledger, records the
              member&rsquo;s acceptance, activates the membership and opens their savings
              account — all at once, or not at all.
            </p>

            <dl className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2">
              <Confirm label="Client">
                {clientName} <span className="font-mono">{clientNumber}</span>
              </Confirm>
              <Confirm label="Acceptance">
                {CONSENT_METHOD_LABELS[consentMethod]}
                <span className="text-text-muted block text-xs">
                  witnessed by{' '}
                  {witnesses.find((w) => w.profileId === witnessProfileId)?.fullName ??
                    ''}
                </span>
              </Confirm>
              <Confirm label="Signed as">{signatureName}</Confirm>
              <Confirm label="Method">
                {PAYMENT_METHOD_LABELS[method]}
                {reference.trim() === '' ? null : (
                  <span className="text-text-muted block font-mono text-xs">
                    {reference.trim().toUpperCase()}
                  </span>
                )}
              </Confirm>
              <Confirm label="Registration fee">
                <span className="tabular-nums">
                  <Money amount={toUgx(registrationFee)} />
                </span>
              </Confirm>
              <Confirm label="Into savings">
                <span className="tabular-nums">
                  {parsedDeposit === null ? (
                    'Nothing today'
                  ) : (
                    <Money amount={toUgx(parsedDeposit)} />
                  )}
                </span>
              </Confirm>
              <Confirm label="Total to collect">
                <span className="text-lg font-semibold tabular-nums">
                  <Money amount={toUgx(total)} />
                </span>
              </Confirm>
            </dl>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="submit" disabled={pending}>
                {pending ? 'Enrolling…' : `Enrol and collect ${formatUgx(toUgx(total))}`}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  setConfirming(false);
                }}
              >
                Change something
              </Button>
            </div>
          </Card>
        ) : null}
      </form>
    </div>
  );
}

function Confirm({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-sm">{label}</dt>
      <dd className="text-text break-words">{children}</dd>
    </div>
  );
}
