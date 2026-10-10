'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PhoneValue } from '@/components/ui/data-value';
import { FormSection, FullWidth } from '@/components/clients/form-section';
import { SelectField } from '@/components/clients/select-field';
import {
  attachClientGuarantorAction,
  attachExternalGuarantorAction,
  recordGuarantorConsentAction,
  removeLoanGuarantorAction,
} from '@/lib/loans/application-actions';
import {
  COMMON_GUARANTOR_RELATIONSHIPS,
  describeGuarantorIneligibility,
} from '@/lib/domain/guarantor';
import { formatRecordedDate } from '@/lib/domain/client';
import type {
  GuarantorCandidate,
  GuarantorConsentTerms,
  LoanGuarantor,
} from '@/lib/data/loan-application';
import type { ActionResult } from '@/lib/auth/actions';

/**
 * Guarantors, captured on the application they guarantee.
 *
 * ## Why this is not a link to the guarantor register
 *
 * The business's paper process is one sitting: the borrower brings somebody,
 * that person's details are written down, they read the undertaking and they
 * sign it. A system that required the guarantor to be pre-registered on a
 * different screen first would be a system staff worked around by registering
 * a placeholder and fixing it later — which is how a register comes to hold
 * three people called "Guarantor".
 *
 * So both routes live here. An existing client is searched and referenced,
 * never copied. Somebody new is captured in full and appears in the Guarantors
 * Register from the moment they are saved.
 *
 * ## Eligibility is shown, not enforced
 *
 * The candidate list shows ineligible people with the reason, because "cannot
 * be chosen" is useful and "mysteriously absent" sends a staff member looking
 * for somebody standing in front of them. The enforcement is the database's:
 * `loan_guarantors_check_eligibility` refuses the write and
 * `validate_loan_for_approval` refuses the approval, both re-evaluated at the
 * moment that matters.
 */
export function LoanGuarantorSection({
  loanId,
  guarantors,
  candidates,
  searchTerm,
  terms,
  editable,
  canLink,
  canCreate,
  requiredCount,
}: {
  readonly loanId: string;
  readonly guarantors: readonly LoanGuarantor[];
  readonly candidates: readonly GuarantorCandidate[];
  readonly searchTerm: string;
  readonly terms: GuarantorConsentTerms | null;
  readonly editable: boolean;
  readonly canLink: boolean;
  readonly canCreate: boolean;
  readonly requiredCount: number;
}) {
  const signed = guarantors.filter((guarantor) => guarantor.consentSigned).length;
  const shortfall = Math.max(0, requiredCount - guarantors.length);

  return (
    <div className="min-w-0 space-y-4">
      {shortfall > 0 ? (
        <Alert tone="warning">
          This application needs{' '}
          {requiredCount === 1 ? 'one guarantor' : `${String(requiredCount)} guarantors`}{' '}
          and has {guarantors.length === 0 ? 'none' : String(guarantors.length)}. An
          approval will be refused until that is met.
        </Alert>
      ) : null}

      {shortfall === 0 && guarantors.length > signed ? (
        <Alert tone="warning">
          {guarantors.length - signed === 1
            ? 'One guarantor has not signed the undertaking.'
            : `${String(guarantors.length - signed)} guarantors have not signed the undertaking.`}{' '}
          An unsigned undertaking is not something the business can hold anybody to, so
          approval will be refused until each has signed.
        </Alert>
      ) : null}

      {guarantors.length === 0 ? (
        <Card>
          <p className="text-text-muted">
            No guarantor has been recorded on this application yet.
          </p>
        </Card>
      ) : (
        <ul className="min-w-0 space-y-3">
          {guarantors.map((guarantor) => (
            <li key={guarantor.id}>
              <GuarantorCard
                loanId={loanId}
                guarantor={guarantor}
                terms={terms}
                editable={editable}
                canLink={canLink}
              />
            </li>
          ))}
        </ul>
      )}

      {editable && (canLink || canCreate) ? (
        <AddGuarantor
          loanId={loanId}
          candidates={candidates}
          searchTerm={searchTerm}
          canLink={canLink}
          canCreate={canCreate}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One guarantor
// ---------------------------------------------------------------------------

function GuarantorCard({
  loanId,
  guarantor,
  terms,
  editable,
  canLink,
}: {
  readonly loanId: string;
  readonly guarantor: LoanGuarantor;
  readonly terms: GuarantorConsentTerms | null;
  readonly editable: boolean;
  readonly canLink: boolean;
}) {
  return (
    <Card className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-text font-medium break-words">{guarantor.fullName}</p>
          <p className="text-text-muted text-sm">
            {guarantor.relationshipToClient}
            {guarantor.clientNumber === null ? null : (
              <>
                {' · '}
                <span className="font-mono">{guarantor.clientNumber}</span>
              </>
            )}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <Badge tone={guarantor.subjectKind === 'client' ? 'info' : 'neutral'}>
            {guarantor.subjectKind === 'client' ? 'Existing client' : 'External'}
          </Badge>
          <Badge tone={guarantor.consentSigned ? 'success' : 'warning'}>
            {guarantor.consentSigned ? 'Undertaking signed' : 'Not signed'}
          </Badge>
        </div>
      </div>

      <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
        <Detail label="Phone">
          <PhoneValue value={guarantor.phone} />
        </Detail>
        <Detail label="Occupation">{guarantor.occupation ?? '—'}</Detail>
        <Detail label="Employer or business">{guarantor.employerName ?? '—'}</Detail>
        <Detail label="Location">
          {guarantor.location ?? '—'}
          {guarantor.district === null ? '' : `, ${guarantor.district}`}
        </Detail>
        <Detail label="Identification on file">
          {guarantor.hasIdentification ? 'Yes' : 'No — approval will be refused'}
        </Detail>
        <Detail label="Documents filed">{String(guarantor.documentCount)}</Detail>
      </dl>

      {guarantor.consentSigned ? (
        <div className="border-border bg-surface-sunken min-w-0 rounded-lg border p-3">
          <p className="text-text text-sm font-medium">
            Undertaking version {guarantor.consentVersion}
          </p>
          <dl className="mt-2 grid min-w-0 gap-3 text-sm sm:grid-cols-2">
            <Detail label="Signed by">{guarantor.signatureName ?? '—'}</Detail>
            <Detail label="Witnessed by">
              {guarantor.witnessName ?? '—'}
              {guarantor.witnessPhone === null ? '' : ` (${guarantor.witnessPhone})`}
            </Detail>
            <Detail label="Signed on">
              {guarantor.consentedAt === null
                ? '—'
                : formatRecordedDate(guarantor.consentedAt)}
            </Detail>
            <Detail label="Place">{guarantor.consentPlace ?? '—'}</Detail>
          </dl>
          <p className="text-text-muted mt-2 text-sm">
            Recorded against the exact wording in force when it was signed. Publishing a
            new version does not change what this guarantor agreed to.
          </p>
        </div>
      ) : editable && canLink ? (
        <ConsentForm loanId={loanId} guarantor={guarantor} terms={terms} />
      ) : (
        <Alert tone="warning">
          This guarantor has not signed the undertaking.
          {editable
            ? ''
            : ' The application has left draft, so it can no longer be taken here.'}
        </Alert>
      )}

      {editable && canLink && !guarantor.consentSigned ? (
        <RemoveGuarantorForm loanId={loanId} guarantor={guarantor} />
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The undertaking
// ---------------------------------------------------------------------------

function ConsentForm({
  loanId,
  guarantor,
  terms,
}: {
  readonly loanId: string;
  readonly guarantor: LoanGuarantor;
  readonly terms: GuarantorConsentTerms | null;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    recordGuarantorConsentAction,
    undefined,
  );

  const [open, setOpen] = useState(false);

  if (terms === null) {
    return (
      <Alert tone="danger">
        No guarantor undertaking is currently published, so a consent cannot be recorded.
        Contact your administrator.
      </Alert>
    );
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          setOpen(true);
        }}
        className="sm:w-auto"
      >
        Take the undertaking
      </Button>
    );
  }

  return (
    <form action={formAction} className="min-w-0 space-y-3" noValidate>
      <input type="hidden" name="loanId" value={loanId} />
      <input type="hidden" name="loanGuarantorId" value={guarantor.id} />

      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      {/*
        The terms are shown in full, not summarised and not behind a link. A
        guarantor is agreeing to pay somebody else's debt; what makes that
        enforceable is that they were shown the words.
      */}
      <div className="border-border bg-surface-sunken min-w-0 rounded-lg border p-3">
        <h4 className="text-text font-medium">
          {terms.title}{' '}
          <span className="text-text-muted font-normal">(version {terms.version})</span>
        </h4>
        <div className="text-text mt-2 max-h-72 overflow-y-auto text-sm whitespace-pre-wrap">
          {terms.body}
        </div>
      </div>

      <div className="flex items-start gap-3">
        <input
          id={`accepted-${guarantor.id}`}
          type="checkbox"
          name="accepted"
          required
          className="accent-accent mt-1 h-5 w-5 shrink-0"
        />
        <Label htmlFor={`accepted-${guarantor.id}`} className="text-sm font-normal">
          {guarantor.fullName} has read the undertaking above, confirms the details given
          are true, and voluntarily agrees to guarantee this loan.
        </Label>
      </div>

      {state?.fieldErrors?.accepted?.[0] !== undefined ? (
        <p role="alert" className="text-danger text-sm">
          {state.fieldErrors.accepted[0]}
        </p>
      ) : null}

      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Field
          label="Signed as"
          name="signatureName"
          required
          defaultValue={guarantor.fullName}
          hint="The name the guarantor wrote. Not a lookup — the point of a signature is that it is what the person signed."
          error={state?.fieldErrors?.signatureName?.[0]}
        />
        <Field
          label="Witness name"
          name="witnessName"
          required
          hint="The member of staff who saw it signed."
          error={state?.fieldErrors?.witnessName?.[0]}
        />
        <Field
          label="Witness phone"
          name="witnessPhone"
          inputMode="tel"
          error={state?.fieldErrors?.witnessPhone?.[0]}
        />
        <Field
          label="Place"
          name="consentPlace"
          hint="Where it was signed."
          error={state?.fieldErrors?.consentPlace?.[0]}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Recording…' : 'Record the undertaking'}
        </Button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
          }}
          className="border-border text-text focus-visible:outline-accent min-h-11 rounded-lg border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Not now
        </button>
      </div>

      <p className="text-text-muted text-sm">
        Once recorded, a signed undertaking cannot be edited. A correction is a fresh
        consent, taken after this guarantor is removed and re-added — which is what
        happens on paper.
      </p>
    </form>
  );
}

function RemoveGuarantorForm({
  loanId,
  guarantor,
}: {
  readonly loanId: string;
  readonly guarantor: LoanGuarantor;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    removeLoanGuarantorAction,
    undefined,
  );

  return (
    <form action={formAction} noValidate>
      <input type="hidden" name="loanId" value={loanId} />
      <input type="hidden" name="loanGuarantorId" value={guarantor.id} />

      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="text-danger focus-visible:outline-accent min-h-11 text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
      >
        {pending ? 'Removing…' : `Remove ${guarantor.fullName} from this application`}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Adding one
// ---------------------------------------------------------------------------

function AddGuarantor({
  loanId,
  candidates,
  searchTerm,
  canLink,
  canCreate,
}: {
  readonly loanId: string;
  readonly candidates: readonly GuarantorCandidate[];
  readonly searchTerm: string;
  readonly canLink: boolean;
  readonly canCreate: boolean;
}) {
  /**
   * The panel opens itself when a search is in the URL.
   *
   * Searching the client register is a GET form, which navigates — and a
   * panel whose openness lived only in component state closed itself on the
   * way back with the results in it. Reading the term makes the state
   * survive the round trip, which is the same reason the filter lives in the
   * URL in the first place. Found by a browser test searching for a client.
   */
  const [mode, setMode] = useState<'none' | 'client' | 'external'>(
    searchTerm === '' ? 'none' : 'client',
  );

  if (mode === 'none') {
    return (
      <Card className="min-w-0 space-y-3">
        <h3 className="text-text font-medium">Add a guarantor</h3>
        <p className="text-text-muted text-sm">
          Either somebody already on the client register, or somebody new. A new guarantor
          is captured here and appears in the guarantor register straight away — there is
          no need to register them first.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          {canLink ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setMode('client');
              }}
              className="sm:w-auto"
            >
              Search existing clients
            </Button>
          ) : null}
          {canCreate ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setMode('external');
              }}
              className="sm:w-auto"
            >
              Capture a new guarantor
            </Button>
          ) : null}
        </div>
      </Card>
    );
  }

  return (
    <Card className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-text font-medium">
          {mode === 'client' ? 'Existing client guarantor' : 'New guarantor'}
        </h3>
        <button
          type="button"
          onClick={() => {
            setMode('none');
          }}
          className="text-text-muted focus-visible:outline-accent min-h-11 text-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Close
        </button>
      </div>

      {mode === 'client' ? (
        <ClientGuarantorPicker
          loanId={loanId}
          candidates={candidates}
          searchTerm={searchTerm}
        />
      ) : (
        <ExternalGuarantorForm loanId={loanId} />
      )}
    </Card>
  );
}

function ClientGuarantorPicker({
  loanId,
  candidates,
  searchTerm,
}: {
  readonly loanId: string;
  readonly candidates: readonly GuarantorCandidate[];
  readonly searchTerm: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    attachClientGuarantorAction,
    undefined,
  );

  const [selected, setSelected] = useState<string>('');

  return (
    <div className="min-w-0 space-y-4">
      {/*
        A plain GET form rather than a fetch. The search runs server-side under
        the caller's own policies, the result is bookmarkable, and there is no
        state to keep in step — the page simply re-renders with a different
        candidate list.
      */}
      <form method="get" className="min-w-0 space-y-1.5">
        <Label htmlFor="guarantor-search">Search the client register</Label>
        <div className="flex min-w-0 gap-2">
          <Input
            id="guarantor-search"
            name="g"
            type="search"
            inputMode="search"
            defaultValue={searchTerm}
            placeholder="Client number, name or phone"
          />
          <Button type="submit" variant="secondary" className="shrink-0 sm:w-auto">
            Search
          </Button>
        </div>
        <p className="text-text-muted text-sm">
          Clients who cannot guarantee this loan are listed with the reason, rather than
          hidden.
        </p>
      </form>

      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      {candidates.length === 0 ? (
        <p className="text-text-muted text-sm">
          {searchTerm === ''
            ? 'Search for a client by number, name or phone.'
            : 'No client matches that search.'}
        </p>
      ) : (
        <form action={formAction} className="min-w-0 space-y-3" noValidate>
          <input type="hidden" name="loanId" value={loanId} />

          <fieldset className="min-w-0 space-y-2">
            <legend className="text-text mb-2 text-sm font-medium">
              Choose a guarantor
            </legend>

            {candidates.map((candidate) => (
              <label
                key={candidate.clientId}
                className={`border-border flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                  candidate.eligible ? 'bg-surface' : 'bg-surface-sunken opacity-80'
                }`}
              >
                <input
                  type="radio"
                  name="guarantorClientId"
                  value={candidate.clientId}
                  disabled={!candidate.eligible}
                  checked={selected === candidate.clientId}
                  onChange={() => {
                    setSelected(candidate.clientId);
                  }}
                  className="accent-accent mt-1 h-5 w-5 shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="text-text block font-medium break-words">
                    {candidate.fullName}
                  </span>
                  <span className="text-text-muted block text-sm">
                    <span className="font-mono">{candidate.clientNumber}</span>
                    {' · '}
                    {candidate.phone}
                    {' · '}
                    {candidate.occupation}
                  </span>

                  {candidate.eligible ? (
                    <span className="text-success mt-1 block text-sm">
                      Eligible to guarantee this loan.
                    </span>
                  ) : (
                    <ul className="text-danger mt-1 list-disc space-y-0.5 pl-5 text-sm">
                      {candidate.reasons.map((reason) => (
                        <li key={reason}>
                          {describeGuarantorIneligibility(reason, {
                            guaranteeingCount: candidate.guaranteeingCount,
                            activeLoanCount: candidate.activeLoanCount,
                          })}
                        </li>
                      ))}
                    </ul>
                  )}
                </span>
              </label>
            ))}
          </fieldset>

          <RelationshipField error={state?.fieldErrors?.relationshipToClient?.[0]} />

          <Button
            type="submit"
            disabled={pending || selected === ''}
            className="sm:w-auto"
          >
            {pending ? 'Adding…' : 'Add this guarantor'}
          </Button>
        </form>
      )}
    </div>
  );
}

function ExternalGuarantorForm({ loanId }: { readonly loanId: string }) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    attachExternalGuarantorAction,
    undefined,
  );

  const fieldError = (name: string): string | undefined =>
    state?.fieldErrors?.[name]?.[0];

  return (
    <form action={formAction} className="min-w-0 space-y-4" noValidate>
      <input type="hidden" name="loanId" value={loanId} />

      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      <FormSection
        title="Who they are"
        description="Captured here and added to the guarantor register at the same time."
      >
        <Field
          label="Full name"
          name="fullName"
          required
          error={fieldError('fullName')}
        />
        <SelectField
          label="Sex"
          name="sex"
          required
          options={[
            { value: '', label: 'Select…' },
            { value: 'female', label: 'Female' },
            { value: 'male', label: 'Male' },
          ]}
          error={fieldError('sex')}
        />
        <Field
          label="Date of birth"
          name="dateOfBirth"
          type="date"
          required
          error={fieldError('dateOfBirth')}
        />
        <Field
          label="National Identification Number"
          name="nin"
          hint="14 letters and digits. Approval is refused without one on file."
          error={fieldError('nin')}
        />
      </FormSection>

      <FormSection title="How to reach them">
        <Field
          label="Phone"
          name="phone"
          inputMode="tel"
          required
          error={fieldError('phone')}
        />
        <Field
          label="Alternative phone"
          name="alternativePhone"
          inputMode="tel"
          error={fieldError('alternativePhone')}
        />
        <Field
          label="Location"
          name="location"
          required
          hint="Village or area."
          error={fieldError('location')}
        />
        <Field label="District" name="district" error={fieldError('district')} />
      </FormSection>

      <FormSection title="What they do">
        <Field
          label="Occupation"
          name="occupation"
          required
          error={fieldError('occupation')}
        />
        <Field
          label="Employer or business"
          name="employerName"
          hint="Who pays them, or the business they trade as."
          error={fieldError('employerName')}
        />
        <FullWidth>
          <RelationshipField error={fieldError('relationshipToClient')} />
        </FullWidth>
      </FormSection>

      <Button type="submit" disabled={pending} className="sm:w-auto">
        {pending ? 'Saving…' : 'Add this guarantor'}
      </Button>

      <p className="text-text-muted text-sm">
        A photograph, their identification and the signed undertaking are attached once
        this guarantor is saved.
      </p>
    </form>
  );
}

/**
 * The relationship to the borrower.
 *
 * A datalist rather than a select: the common relationships are offered and
 * anything may be typed, because a lending business meets relationships no
 * list anticipates. The column is free text with a not-blank constraint, and
 * this is that rule in the layer a person sees.
 */
function RelationshipField({ error }: { readonly error?: string }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor="relationship" required>
        Relationship to the borrower
      </Label>
      <Input
        id="relationship"
        name="relationshipToClient"
        list="guarantor-relationships"
        required
        invalid={error !== undefined}
        placeholder="Brother, neighbour, business partner…"
      />
      <datalist id="guarantor-relationships">
        {COMMON_GUARANTOR_RELATIONSHIPS.map((relationship) => (
          <option key={relationship} value={relationship} />
        ))}
      </datalist>
      {error !== undefined ? (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Detail({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-text mt-0.5 break-words">{children}</dd>
    </div>
  );
}
