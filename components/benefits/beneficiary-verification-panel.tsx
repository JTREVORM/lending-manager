'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, SelectField } from '@/components/ui/field';
import {
  revokeBeneficiaryAction,
  verifyBeneficiaryAction,
  type BenefitActionResult,
} from '@/lib/benefits/actions';
import type { BenefitDocument } from '@/lib/data/benefits';
import {
  BENEFICIARY_EVIDENCE_KINDS,
  BENEFICIARY_EVIDENCE_KIND_LABELS,
  beneficiaryEvidenceNeedsDocument,
  type BeneficiaryEvidenceKind,
} from '@/lib/domain/benefits';

/**
 * Checking a beneficiary record, and withdrawing one.
 *
 * ## Two hands, enforced below this screen
 *
 * `verify_member_beneficiary` refuses the person who recorded the record. So
 * the panel can be rendered for anybody holding `beneficiaries:verify` and the
 * control does not depend on this component getting it right — which is what
 * makes it a control rather than a convention.
 *
 * ## The evidence kind is a claim about what was checked
 *
 * Four kinds, and two of them carry a document. For those two the database
 * checks that the named object **actually exists in the private bucket under
 * this membership's own folder**, which is the difference between "somebody
 * typed a filename" and "somebody looked at a document". A path naming
 * another membership's file is the forgery that check exists for.
 *
 * So the form offers the documents already attached to this record rather
 * than a text field. A path nobody can see is a path nobody can verify
 * against, and typing one is not a thing anybody should be asked to do.
 *
 * ## Refusing needs a reason and accepting does not
 *
 * Asymmetric on purpose. "I saw the birth certificate" needs no essay; "I am
 * not accepting this" has to reach whoever will have to tell the member.
 */
export function BeneficiaryVerificationPanel({
  beneficiaryId,
  verificationStatus,
  documents,
  canVerify,
  canManage,
  isActive,
}: {
  readonly beneficiaryId: string;
  readonly verificationStatus: 'pending_verification' | 'verified' | 'rejected';
  readonly documents: readonly BenefitDocument[];
  readonly canVerify: boolean;
  readonly canManage: boolean;
  readonly isActive: boolean;
}) {
  const [verifyResult, verify, verifying] = useActionState<
    BenefitActionResult | undefined,
    FormData
  >(verifyBeneficiaryAction, undefined);

  const [revokeResult, revoke, revoking] = useActionState<
    BenefitActionResult | undefined,
    FormData
  >(revokeBeneficiaryAction, undefined);

  const [evidenceKind, setEvidenceKind] = useState<BeneficiaryEvidenceKind | ''>('');
  const [refusing, setRefusing] = useState(false);
  const [revokingOpen, setRevokingOpen] = useState(false);

  const needsDocument =
    evidenceKind !== '' && beneficiaryEvidenceNeedsDocument(evidenceKind);

  // Only the checked documents are offered. Verifying a relationship against
  // a document nobody has checked would make the second pair of hands
  // decorative — which is the failure this whole evidence design is about.
  const usable = documents.filter(
    (document) => document.verificationStatus === 'verified',
  );

  const showVerification = canVerify && verificationStatus === 'pending_verification';
  const showRevoke = canManage && isActive;

  if (!showVerification && !showRevoke) return null;

  return (
    <Card>
      <h2 className="text-text text-sm font-semibold">What happens next</h2>

      {showVerification ? (
        <form action={verify} className="mt-3 min-w-0 space-y-4">
          <input type="hidden" name="beneficiaryId" value={beneficiaryId} />
          <input type="hidden" name="verified" value={refusing ? 'false' : 'true'} />

          {verifyResult?.ok === false ? (
            <Alert tone="danger">{verifyResult.message}</Alert>
          ) : null}

          <SelectField
            label="What does the check rest on?"
            name="evidenceKind"
            required
            placeholder="Choose what was checked…"
            value={evidenceKind}
            onChange={(event) => {
              setEvidenceKind(event.target.value as BeneficiaryEvidenceKind | '');
            }}
            options={BENEFICIARY_EVIDENCE_KINDS.map((kind) => ({
              value: kind,
              label: BENEFICIARY_EVIDENCE_KIND_LABELS[kind],
            }))}
            error={verifyResult?.fieldErrors?.evidenceKind?.[0]}
          />

          {needsDocument ? (
            usable.length === 0 ? (
              <Alert tone="warning" title="No checked document to verify against">
                Attach the document below and have it checked first. The database confirms
                the object exists under this member&rsquo;s own folder, so a record cannot
                be verified against a file nobody uploaded.
              </Alert>
            ) : (
              <SelectField
                label="Which document?"
                name="evidencePath"
                required
                placeholder="Choose the document…"
                options={usable.map((document) => ({
                  value: document.objectPath,
                  label:
                    document.label === null
                      ? document.kindLabel
                      : `${document.kindLabel} — ${document.label}`,
                }))}
                error={verifyResult?.fieldErrors?.evidencePath?.[0]}
                hint="Only documents that have been checked are offered."
              />
            )
          ) : null}

          {refusing ? (
            <Field
              label="Why is the record not accepted?"
              name="note"
              type="text"
              required
              autoFocus
              error={verifyResult?.fieldErrors?.note?.[0]}
              hint="Somebody will have to tell the member, so say what is wrong with it."
            />
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              disabled={
                verifying || evidenceKind === '' || (needsDocument && usable.length === 0)
              }
              variant={refusing ? 'danger' : 'primary'}
            >
              {verifying
                ? 'Recording…'
                : refusing
                  ? 'Refuse this record'
                  : 'Verify this beneficiary'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setRefusing(!refusing);
              }}
            >
              {refusing ? 'Verify it instead' : 'Refuse it instead'}
            </Button>
          </div>

          <p className="text-text-muted text-xs">
            Whoever recorded this beneficiary cannot be the person who checks it. That is
            refused in the database, so it holds however this screen is reached.
          </p>
        </form>
      ) : null}

      {showRevoke ? (
        <div className={showVerification ? 'border-border mt-4 border-t pt-4' : 'mt-3'}>
          {revokingOpen ? (
            <form action={revoke} className="min-w-0 space-y-3">
              <input type="hidden" name="beneficiaryId" value={beneficiaryId} />

              {revokeResult?.ok === false ? (
                <Alert tone="danger">{revokeResult.message}</Alert>
              ) : null}

              <Field
                label="Why is this record being withdrawn?"
                name="reason"
                type="text"
                required
                autoFocus
                error={revokeResult?.fieldErrors?.reason?.[0]}
                hint="The record is kept with its details and its verification intact — withdrawing it only stops it being paid. A replacement is registered rather than an edit."
              />

              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="danger" disabled={revoking}>
                  {revoking ? 'Recording…' : 'Withdraw this record'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={revoking}
                  onClick={() => {
                    setRevokingOpen(false);
                  }}
                >
                  Never mind
                </Button>
              </div>
            </form>
          ) : (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setRevokingOpen(true);
              }}
            >
              Withdraw this record
            </Button>
          )}
        </div>
      ) : null}
    </Card>
  );
}
