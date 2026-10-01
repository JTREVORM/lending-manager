'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { FormSection, FullWidth } from './form-section';
import { SelectField } from './select-field';
import { createClientAndRedirect } from '@/lib/clients/actions';
import { updateClientAction } from '@/lib/clients/actions';
import { SEXES, SEX_LABELS } from '@/lib/domain/client';
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  ALLOWED_PHOTO_MIME_TYPES,
} from '@/lib/validation/client';
import type { ClientDetail } from '@/lib/data/clients';
import type { ActionResult } from '@/lib/auth/actions';
import type { ClientActionResult } from '@/lib/clients/actions';

const SEX_OPTIONS = [
  { value: '', label: 'Select…' },
  ...SEXES.map((sex) => ({ value: sex, label: SEX_LABELS[sex] })),
];

/**
 * Register or edit a client.
 *
 * One component for both, because the fields and their validation are the
 * same and keeping two copies in step by hand is how they drift. The
 * differences are explicit: an edit has no file inputs (documents are replaced
 * from the client's page, under a different capability) and no NIN field
 * unless the viewer may read one.
 *
 * `noValidate` is deliberate. The browser's own validation bubbles cannot be
 * styled, are not announced consistently by screen readers, and would show a
 * message that disagrees with the server's. The server's messages are the
 * only ones shown.
 *
 * Grouped into sections because a single twelve-field column on a phone is a
 * scroll with no landmarks. The groups match how the business's paper form is
 * laid out, so somebody copying from paper reads down the page in order.
 */
export function ClientForm({
  client,
  canRecordNin,
  canUploadDocuments,
}: {
  /** Absent when registering. */
  readonly client?: ClientDetail;
  readonly canRecordNin: boolean;
  readonly canUploadDocuments: boolean;
}) {
  const editing = client !== undefined;

  const [state, formAction, pending] = useActionState<
    ClientActionResult | ActionResult | undefined,
    FormData
  >(editing ? updateClientAction : createClientAndRedirect, undefined);

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

      {editing ? <input type="hidden" name="clientId" value={client.id} /> : null}

      <FormSection
        title="Personal information"
        description="As written on the client's identification."
      >
        <FullWidth>
          <Field
            label="Full name"
            name="fullName"
            autoComplete="name"
            required
            defaultValue={client?.fullName}
            error={fieldError('fullName')}
          />
        </FullWidth>

        <SelectField
          label="Sex"
          name="sex"
          required
          options={SEX_OPTIONS}
          defaultValue={client?.sex}
          error={fieldError('sex')}
        />

        <Field
          label="Date of birth"
          name="dateOfBirth"
          type="date"
          required
          defaultValue={client?.dateOfBirth}
          hint="A client must be at least 18."
          error={fieldError('dateOfBirth')}
        />

        <Field
          label="Phone number"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          defaultValue={client?.phone}
          hint="07xx xxx xxx, or +256…"
          error={fieldError('phone')}
        />

        <Field
          label="Alternative phone"
          name="alternativePhone"
          type="tel"
          inputMode="tel"
          defaultValue={client?.alternativePhone ?? ''}
          hint="Optional. A relative or neighbour."
          error={fieldError('alternativePhone')}
        />
      </FormSection>

      {canRecordNin ? (
        <FormSection
          title="Identification"
          description="The National Identification Number is stored separately and is visible only to staff authorised to see it."
        >
          <FullWidth>
            <Field
              label="National Identification Number"
              name="nin"
              autoCapitalize="characters"
              spellCheck={false}
              defaultValue=""
              hint="Optional. 14 characters, beginning CM or CF. Leave blank if the card is not present."
              error={fieldError('nin')}
            />
          </FullWidth>
        </FormSection>
      ) : null}

      <FormSection title="Location">
        <Field
          label="Village or area"
          name="villageArea"
          required
          defaultValue={client?.villageArea}
          error={fieldError('villageArea')}
        />

        <Field
          label="District"
          name="district"
          required
          defaultValue={client?.district}
          error={fieldError('district')}
        />
      </FormSection>

      <FormSection title="Work">
        <Field
          label="Occupation"
          name="occupation"
          required
          defaultValue={client?.occupation}
          hint="What they do, e.g. Trader, Boda rider, Teacher."
          error={fieldError('occupation')}
        />

        <Field
          label="Business type"
          name="businessType"
          defaultValue={client?.businessType ?? ''}
          hint="Optional. For a trader: produce, clothing, hardware…"
          error={fieldError('businessType')}
        />
      </FormSection>

      {!editing && canUploadDocuments ? (
        <FormSection
          title="Photograph and documents"
          description="Stored in a private bucket. Never published, and never served from a permanent address."
        >
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="client-photo">Photograph</Label>
            <input
              id="client-photo"
              name="photo"
              type="file"
              accept={ALLOWED_PHOTO_MIME_TYPES.join(',')}
              capture="environment"
              className="border-border bg-surface text-text file:bg-surface-raised file:text-text focus-visible:outline-accent block w-full rounded-lg border p-2 text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-2 file:text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
            />
            <p className="text-text-muted text-sm">Optional. Up to 5 MB.</p>
          </div>

          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="client-id-document">Identification document</Label>
            <input
              id="client-id-document"
              name="idDocument"
              type="file"
              accept={ALLOWED_DOCUMENT_MIME_TYPES.join(',')}
              className="border-border bg-surface text-text file:bg-surface-raised file:text-text focus-visible:outline-accent block w-full rounded-lg border p-2 text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-2 file:text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
            />
            <p className="text-text-muted text-sm">
              Optional. A photograph of the card, or a PDF scan.
            </p>
          </div>
        </FormSection>
      ) : null}

      <FormSection title="Notes">
        <FullWidth>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="client-notes">Notes</Label>
            <textarea
              id="client-notes"
              name="notes"
              rows={3}
              maxLength={2000}
              defaultValue={client?.notes ?? ''}
              className="border-border bg-surface text-text focus-visible:outline-accent w-full rounded-lg border p-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2"
            />
            <p className="text-text-muted text-sm">
              Optional. Anything useful about finding or identifying the client. Follow-up
              concerns belong in remarks, which are attributed and cannot be edited.
            </p>
          </div>
        </FullWidth>
      </FormSection>

      <div className="flex flex-col gap-3 sm:flex-row-reverse">
        <Button type="submit" disabled={pending} className="sm:w-auto">
          {pending
            ? editing
              ? 'Saving…'
              : 'Registering…'
            : editing
              ? 'Save changes'
              : 'Register client'}
        </Button>
      </div>
    </form>
  );
}
