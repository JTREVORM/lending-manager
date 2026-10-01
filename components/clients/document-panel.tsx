'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { replaceClientDocumentAction } from '@/lib/clients/actions';
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  ALLOWED_PHOTO_MIME_TYPES,
} from '@/lib/validation/client';
import type { ActionResult } from '@/lib/auth/actions';

/**
 * A client's photograph and identity document.
 *
 * The URLs are signed server-side and expire in a minute, so nothing here is a
 * permanent address. That is why the image is rendered with a plain `img`
 * rather than Next.js's optimiser: the optimiser would need the URL
 * allow-listed and would cache the result, which would quietly create the
 * long-lived public copy the signing exists to avoid.
 *
 * Replacing uploads the new file first and repoints the record only after that
 * succeeds, so a failed upload leaves the previous document in place and still
 * referenced. The old object is never deleted — identity evidence is not
 * freely destructible, and a bug that deleted the only scan of a client's
 * national ID would be unrecoverable.
 */
export function DocumentPanel({
  clientId,
  photoUrl,
  documentUrl,
  hasDocument,
  canSeeDocument,
  canReplace,
}: {
  readonly clientId: string;
  readonly photoUrl: string | null;
  readonly documentUrl: string | null;
  readonly hasDocument: boolean;
  readonly canSeeDocument: boolean;
  readonly canReplace: boolean;
}) {
  return (
    <div className="grid min-w-0 gap-4 sm:grid-cols-2">
      <Card className="min-w-0 space-y-3">
        <h3 className="text-text font-medium">Photograph</h3>

        {photoUrl === null ? (
          <p className="text-text-muted text-sm">No photograph on record.</p>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element --
             The source is a one-minute signed URL. Routing it through the
             image optimiser would cache a copy at a stable address, which is
             exactly what the short expiry is there to prevent. */
          <img
            src={photoUrl}
            alt="Client photograph"
            className="border-border h-40 w-40 rounded-lg border object-cover"
          />
        )}

        {canReplace ? (
          <ReplaceForm
            clientId={clientId}
            kind="photo"
            accept={ALLOWED_PHOTO_MIME_TYPES.join(',')}
            label={photoUrl === null ? 'Add a photograph' : 'Replace the photograph'}
          />
        ) : null}
      </Card>

      <Card className="min-w-0 space-y-3">
        <h3 className="text-text font-medium">Identification document</h3>

        {!canSeeDocument ? (
          <p className="text-text-muted text-sm">
            Restricted. You do not have permission to view identity documents.
          </p>
        ) : !hasDocument ? (
          <p className="text-text-muted text-sm">No document on record.</p>
        ) : documentUrl === null ? (
          <p className="text-text-muted text-sm">
            A document is on record but could not be opened just now.
          </p>
        ) : (
          <a
            href={documentUrl}
            target="_blank"
            rel="noreferrer"
            className="text-accent focus-visible:outline-accent inline-flex min-h-11 items-center text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Open the document
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}

        {canReplace && canSeeDocument ? (
          <ReplaceForm
            clientId={clientId}
            kind="id"
            accept={ALLOWED_DOCUMENT_MIME_TYPES.join(',')}
            label={hasDocument ? 'Replace the document' : 'Add a document'}
          />
        ) : null}
      </Card>
    </div>
  );
}

function ReplaceForm({
  clientId,
  kind,
  accept,
  label,
}: {
  readonly clientId: string;
  readonly kind: 'photo' | 'id';
  readonly accept: string;
  readonly label: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    replaceClientDocumentAction,
    undefined,
  );

  const inputId = `replace-${kind}-${clientId}`;

  return (
    <form action={formAction} className="space-y-3" encType="multipart/form-data">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="kind" value={kind} />

      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      <div className="min-w-0 space-y-1.5">
        <Label htmlFor={inputId}>{label}</Label>
        <input
          id={inputId}
          name="file"
          type="file"
          accept={accept}
          required
          className="border-border bg-surface text-text file:bg-surface-raised file:text-text focus-visible:outline-accent block w-full rounded-lg border p-2 text-sm file:mr-3 file:rounded-md file:border-0 file:px-3 file:py-2 file:text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
        />
        <p className="text-text-muted text-sm">Up to 5 MB. The previous file is kept.</p>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? 'Uploading…' : 'Upload'}
      </Button>
    </form>
  );
}
