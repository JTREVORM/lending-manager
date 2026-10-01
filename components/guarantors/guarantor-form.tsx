'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { FormSection, FullWidth } from '@/components/clients/form-section';
import { SelectField } from '@/components/clients/select-field';
import { createGuarantorAction, updateGuarantorAction } from '@/lib/guarantors/actions';
import { SEXES, SEX_LABELS } from '@/lib/domain/client';
import { ALLOWED_PHOTO_MIME_TYPES } from '@/lib/validation/client';
import type { GuarantorDetail } from '@/lib/data/guarantors';
import type { ActionResult } from '@/lib/auth/actions';
import type { GuarantorActionResult } from '@/lib/guarantors/actions';

const SEX_OPTIONS = [
  { value: '', label: 'Select…' },
  ...SEXES.map((sex) => ({ value: sex, label: SEX_LABELS[sex] })),
];

/**
 * Register or edit a guarantor.
 *
 * `clientId` is carried through when the flow started from a client's page, so
 * registering and attaching happen in one submission. The relationship field
 * appears only in that case, because a relationship without a client to relate
 * to would be meaningless.
 */
export function GuarantorForm({
  guarantor,
  nin,
  canRecordNin,
  attachToClientId,
}: {
  readonly guarantor?: GuarantorDetail;
  /** The existing number, shown only when the viewer may read it. */
  readonly nin?: string | null;
  readonly canRecordNin: boolean;
  readonly attachToClientId?: string;
}) {
  const editing = guarantor !== undefined;

  const [state, formAction, pending] = useActionState<
    GuarantorActionResult | ActionResult | undefined,
    FormData
  >(editing ? updateGuarantorAction : createGuarantorAction, undefined);

  const fieldError = (name: string): string | undefined =>
    state?.fieldErrors?.[name]?.[0];

  return (
    <form
      action={formAction}
      className="space-y-4"
      noValidate
      encType="multipart/form-data"
    >
      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      {editing ? <input type="hidden" name="guarantorId" value={guarantor.id} /> : null}

      {attachToClientId !== undefined ? (
        <input type="hidden" name="clientId" value={attachToClientId} />
      ) : null}

      <FormSection
        title="Personal information"
        description="As written on the guarantor's identification."
      >
        <FullWidth>
          <Field
            label="Full name"
            name="fullName"
            autoComplete="name"
            required
            defaultValue={guarantor?.fullName}
            error={fieldError('fullName')}
          />
        </FullWidth>

        <SelectField
          label="Sex"
          name="sex"
          required
          options={SEX_OPTIONS}
          defaultValue={guarantor?.sex}
          error={fieldError('sex')}
        />

        <Field
          label="Date of birth"
          name="dateOfBirth"
          type="date"
          required
          defaultValue={guarantor?.dateOfBirth}
          hint="A guarantor must be at least 18."
          error={fieldError('dateOfBirth')}
        />

        <Field
          label="Phone number"
          name="phone"
          type="tel"
          inputMode="tel"
          required
          defaultValue={guarantor?.phone}
          hint="07xx xxx xxx, or +256…"
          error={fieldError('phone')}
        />

        <Field
          label="Alternative phone"
          name="alternativePhone"
          type="tel"
          inputMode="tel"
          defaultValue={guarantor?.alternativePhone ?? ''}
          hint="Optional."
          error={fieldError('alternativePhone')}
        />
      </FormSection>

      {canRecordNin ? (
        <FormSection
          title="Identification"
          description="Stored separately from the rest of the record and visible only to authorised staff."
        >
          <FullWidth>
            <Field
              label="National Identification Number"
              name="nin"
              autoCapitalize="characters"
              spellCheck={false}
              defaultValue={nin ?? ''}
              hint="Optional. 14 characters, beginning CM or CF."
              error={fieldError('nin')}
            />
          </FullWidth>
        </FormSection>
      ) : null}

      <FormSection title="Location and work">
        <Field
          label="Location"
          name="location"
          required
          defaultValue={guarantor?.location}
          hint="Village, area or trading centre."
          error={fieldError('location')}
        />

        <Field
          label="District"
          name="district"
          defaultValue={guarantor?.district ?? ''}
          hint="Optional."
          error={fieldError('district')}
        />

        <FullWidth>
          <Field
            label="Occupation"
            name="occupation"
            required
            defaultValue={guarantor?.occupation}
            error={fieldError('occupation')}
          />
        </FullWidth>
      </FormSection>

      {attachToClientId !== undefined ? (
        <FormSection
          title="Relationship"
          description="How this guarantor knows the client. Recorded against this attachment, not against the person — the same guarantor may be a brother to one client and a business partner to another."
        >
          <FullWidth>
            <Field
              label="Relationship to the client"
              name="relationshipToClient"
              required
              hint="For example: Brother, Business partner, Neighbour."
              error={fieldError('relationshipToClient')}
            />
          </FullWidth>
        </FormSection>
      ) : null}

      {!editing ? (
        <FormSection
          title="Photograph"
          description="Stored in a private bucket, readable only by staff who may view guarantors."
        >
          <FullWidth>
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="guarantor-photo">Photograph</Label>
              <input
                id="guarantor-photo"
                name="photo"
                type="file"
                accept={ALLOWED_PHOTO_MIME_TYPES.join(',')}
                capture="environment"
                className="border-border bg-surface text-text file:bg-surface-raised file:text-text focus-visible:outline-accent block w-full rounded-lg border p-2 text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-2 file:text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
              />
              <p className="text-text-muted text-sm">Optional. Up to 5 MB.</p>
            </div>
          </FullWidth>
        </FormSection>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row-reverse">
        <Button type="submit" disabled={pending} className="sm:w-auto">
          {pending
            ? editing
              ? 'Saving…'
              : 'Registering…'
            : editing
              ? 'Save changes'
              : 'Register guarantor'}
        </Button>
      </div>
    </form>
  );
}
