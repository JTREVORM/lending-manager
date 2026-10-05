'use client';

import Link from 'next/link';

import { RowLink } from '@/components/ui/row-link';
import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { detachGuarantorAction, linkGuarantorAction } from '@/lib/guarantors/actions';
import { formatRecordedDate } from '@/lib/domain/client';
import type { ClientGuarantor } from '@/lib/data/guarantors';
import type { ActionResult } from '@/lib/auth/actions';
import { PhoneValue } from '@/components/ui/data-value';

/**
 * The guarantors standing for a client.
 *
 * Detached associations are shown, greyed and labelled, rather than hidden.
 * "Who used to guarantee this person, and why they stopped" is part of the
 * client's history, and Phase 4 will care about it when a loan is assessed.
 *
 * Attaching is a two-step flow by design — search the existing guarantors
 * first, register a new one only if nobody matches. That is what keeps one
 * person from becoming three records, which in turn is what makes "this
 * individual already stands for two other borrowers" visible to whoever is
 * approving the next loan.
 */
export function ClientGuarantorPanel({
  clientId,
  links,
  canLink,
}: {
  readonly clientId: string;
  readonly links: readonly ClientGuarantor[];
  readonly canLink: boolean;
}) {
  const [attaching, setAttaching] = useState(false);
  const active = links.filter((link) => link.active);
  const detached = links.filter((link) => !link.active);

  return (
    <div className="space-y-4">
      {active.length === 0 ? (
        <Card>
          <p className="text-text-muted">No guarantor is attached to this client.</p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {active.map((link) => (
            <li
              key={link.linkId}
              className="border-border bg-surface min-w-0 rounded-xl border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <RowLink
                    href={`/guarantors/${link.guarantorId}`}
                    className="text-accent focus-visible:outline-accent font-medium break-words underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                  >
                    {link.fullName}
                  </RowLink>
                  <p className="text-text-muted text-sm">
                    {link.relationshipToClient} · <PhoneValue value={link.phone} />
                  </p>
                  <p className="text-text-muted text-sm break-words">
                    {link.occupation} · {link.location}
                  </p>
                </div>

                {canLink ? <DetachForm clientId={clientId} linkId={link.linkId} /> : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {detached.length > 0 ? (
        <details className="border-border bg-surface rounded-xl border p-4">
          <summary className="text-text min-h-11 cursor-pointer text-sm font-medium">
            Previous guarantors ({String(detached.length)})
          </summary>
          <ul className="mt-3 space-y-3">
            {detached.map((link) => (
              <li key={link.linkId} className="min-w-0 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-text-muted break-words">{link.fullName}</span>
                  <Badge tone="neutral">Detached</Badge>
                </div>
                <p className="text-text-muted">
                  {link.relationshipToClient}
                  {link.detachedAt !== null
                    ? ` · ${formatRecordedDate(link.detachedAt)}`
                    : ''}
                </p>
                {link.detachedReason !== null ? (
                  <p className="text-text-muted break-words">
                    Reason: {link.detachedReason}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {canLink ? (
        attaching ? (
          <AttachForm
            clientId={clientId}
            onCancel={() => {
              setAttaching(false);
            }}
          />
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              type="button"
              onClick={() => {
                setAttaching(true);
              }}
              className="sm:w-auto"
            >
              Attach an existing guarantor
            </Button>
            <Link
              href={`/guarantors/new?clientId=${encodeURIComponent(clientId)}`}
              className="border-border text-text focus-visible:outline-accent inline-flex min-h-11 items-center justify-center rounded-lg border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Register a new guarantor
            </Link>
          </div>
        )
      ) : null}
    </div>
  );
}

/**
 * Attach by guarantor id.
 *
 * The id is pasted or arrived at from the guarantor directory rather than
 * typed, which is why this is a plain field and not a combo box: a searchable
 * picker that queries on every keystroke is a lot of machinery for a flow
 * whose natural path is "find them in the directory, then attach".
 */
function AttachForm({
  clientId,
  onCancel,
}: {
  readonly clientId: string;
  readonly onCancel: () => void;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    linkGuarantorAction,
    undefined,
  );

  return (
    <Card>
      <form action={formAction} className="space-y-4" noValidate>
        <input type="hidden" name="clientId" value={clientId} />

        {state?.message !== undefined ? (
          <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
        ) : null}

        <p className="text-text-muted text-sm">
          Find the person in the{' '}
          <Link
            href="/guarantors"
            className="text-accent underline-offset-2 hover:underline"
          >
            guarantor directory
          </Link>{' '}
          and copy their reference from the address bar.
        </p>

        <Field
          label="Guarantor reference"
          name="guarantorId"
          required
          spellCheck={false}
          error={state?.fieldErrors?.guarantorId?.[0]}
        />

        <Field
          label="Relationship to the client"
          name="relationshipToClient"
          required
          hint="How they know each other, e.g. Brother, Business partner, Neighbour."
          error={state?.fieldErrors?.relationshipToClient?.[0]}
        />

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'Attaching…' : 'Attach guarantor'}
          </Button>
          <button
            type="button"
            onClick={onCancel}
            className="border-border text-text focus-visible:outline-accent min-h-11 rounded-lg border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}

/** Detach, with a reason. Deactivates; the database refuses to revive it. */
function DetachForm({
  clientId,
  linkId,
}: {
  readonly clientId: string;
  readonly linkId: string;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    detachGuarantorAction,
    undefined,
  );

  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => {
          setConfirming(true);
        }}
        className="text-danger focus-visible:outline-accent min-h-11 shrink-0 text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        Detach
      </button>
    );
  }

  return (
    <form action={formAction} className="border-border w-full space-y-3 border-t pt-3">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="linkId" value={linkId} />

      {state?.message !== undefined && !state.ok ? (
        <Alert tone="danger">{state.message}</Alert>
      ) : null}

      <div className="min-w-0 space-y-1.5">
        <Label htmlFor={`detach-${linkId}`}>Reason</Label>
        <input
          id={`detach-${linkId}`}
          name="reason"
          maxLength={300}
          className="border-border bg-surface text-text focus-visible:outline-accent h-11 w-full rounded-lg border px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2"
        />
        <p className="text-text-muted text-sm">
          Optional. The association is kept as history rather than removed.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Detaching…' : 'Confirm detach'}
        </Button>
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
          }}
          className="border-border text-text focus-visible:outline-accent min-h-11 rounded-lg border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
