'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';

import { MembershipCardStatusBadge } from '@/components/savings/savings-badges';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import {
  CARD_REISSUE_REASONS,
  MEMBERSHIP_CARD_REASON_LABELS,
  type MembershipCardReason,
} from '@/lib/domain/savings';
import {
  issueMembershipCardAction,
  type MembershipActionResult,
} from '@/lib/membership/actions';
import type { MembershipCardSummary } from '@/lib/data/savings';

/**
 * A member's card, and issuing or reissuing it.
 *
 * ## The verification code is shown, and it is safe to show here
 *
 * It is opaque and random: twelve characters from a 32-symbol alphabet that
 * leaves out I, O, 0 and 1 so a code read over a phone cannot be mistyped into
 * another valid one. It is not a token, not a key and not derived from any
 * identifier, so it grants nothing — a QR code encoding it tells a stranger
 * who finds the card nothing at all. What it does is let somebody who already
 * holds `membership:view` confirm that the card in front of them is the card
 * this system issued.
 *
 * It is minted by the database, never by a caller. A screen that could choose
 * it could print a card whose code matched somebody else's.
 *
 * ## Reissuing supersedes rather than replaces
 *
 * The old card is marked superseded and stays in the list. A member who turns
 * up with a card the business withdrew should be identifiable as holding a
 * withdrawn card, which is impossible if the row was overwritten. Exactly one
 * card per membership is ever current — enforced by a partial unique index, so
 * two current cards cannot exist however they are created.
 *
 * ## A card is for a member
 *
 * `issue_membership_card` refuses a pending or ended membership, because a
 * card says "this person is a member" and a pending application is not one
 * yet. So the control is absent rather than present-and-refusing, with the
 * reason stated.
 */
export function MembershipCardPanel({
  membershipId,
  membershipStatus,
  cards,
  canIssue,
}: {
  readonly membershipId: string;
  readonly membershipStatus: string;
  readonly cards: readonly MembershipCardSummary[];
  readonly canIssue: boolean;
}) {
  const router = useRouter();

  const [result, submit, pending] = useActionState<
    MembershipActionResult | undefined,
    FormData
  >(async (previous, formData) => {
    const next = await issueMembershipCardAction(previous, formData);
    if (next.ok) router.refresh();
    return next;
  }, undefined);

  const [reason, setReason] = useState<MembershipCardReason>('lost');
  const [reissuing, setReissuing] = useState(false);

  const current = cards.find((card) => card.status === 'active') ?? null;
  const superseded = cards.filter((card) => card.status !== 'active');

  const issuable = membershipStatus === 'active' || membershipStatus === 'suspended';

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-text text-sm font-semibold">Membership card</h3>
        {current === null ? null : <MembershipCardStatusBadge status={current.status} />}
      </div>

      {result?.ok === false ? (
        <Alert tone="danger" className="mt-3">
          {result.message}
        </Alert>
      ) : null}
      {result?.ok === true ? (
        <Alert tone="success" className="mt-3">
          {result.message}
        </Alert>
      ) : null}

      {/* --- The current card -------------------------------------------- */}
      {current === null ? (
        <p className="text-text-muted mt-1 text-sm">
          {issuable
            ? 'No card has been issued to this member yet.'
            : 'No card has been issued. A card says the holder is a member, so it is issued once the membership is active.'}
        </p>
      ) : (
        <div className="border-border mt-3 min-w-0 rounded-lg border p-4">
          <p className="text-text-muted text-xs">{current.printedName}</p>
          <p className="text-text mt-1 font-mono text-lg font-semibold tracking-widest">
            {current.verificationCode}
          </p>
          <dl className="mt-3 grid min-w-0 gap-2 text-xs sm:grid-cols-3">
            <div className="min-w-0">
              <dt className="text-text-muted">Card number</dt>
              <dd className="text-text font-mono">{current.cardNumber}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-text-muted">Issued</dt>
              <dd className="text-text">
                <DateValue value={current.issuedOn} />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-text-muted">Issued by</dt>
              <dd className="text-text break-words">{current.issuedByLabel}</dd>
            </div>
          </dl>
          <p className="text-text-muted mt-2 text-xs">
            The code confirms this card is the one the system issued. It grants nothing on
            its own.
          </p>
        </div>
      )}

      {/* --- Issuing ----------------------------------------------------- */}
      {canIssue && issuable ? (
        current === null ? (
          <form action={submit} className="mt-3">
            <input type="hidden" name="membershipId" value={membershipId} />
            <input type="hidden" name="reason" value="first_issue" />
            <Button type="submit" variant="secondary" disabled={pending}>
              {pending ? 'Issuing…' : 'Issue a card'}
            </Button>
          </form>
        ) : reissuing ? (
          <form action={submit} className="mt-3 min-w-0 space-y-3">
            <input type="hidden" name="membershipId" value={membershipId} />

            <div className="min-w-0">
              <label
                htmlFor="reissue-reason"
                className="text-text mb-1 block text-sm font-medium"
              >
                Why is it being replaced?
              </label>
              <select
                id="reissue-reason"
                name="reason"
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value as MembershipCardReason);
                }}
                className="border-border bg-surface text-text focus-visible:outline-accent min-h-11 w-full rounded-lg border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                {CARD_REISSUE_REASONS.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {MEMBERSHIP_CARD_REASON_LABELS[candidate]}
                  </option>
                ))}
              </select>
              <p className="text-text-muted mt-1 text-xs">
                Card {current.cardNumber} stops being current and stays in the history, so
                a member turning up with it can be identified as holding a withdrawn card.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="secondary" disabled={pending}>
                {pending ? 'Reissuing…' : 'Issue a replacement'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  setReissuing(false);
                }}
              >
                Back
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-3">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setReissuing(true);
              }}
            >
              Replace this card
            </Button>
          </div>
        )
      ) : null}

      {/* --- Withdrawn cards --------------------------------------------- */}
      {superseded.length === 0 ? null : (
        <div className="border-border mt-4 border-t pt-3">
          <p className="text-text-muted text-xs">
            {superseded.length === 1 ? 'One earlier card' : 'Earlier cards'}
          </p>
          <ul className="mt-1.5 space-y-1">
            {superseded.map((card) => (
              <li
                key={card.id}
                className="text-text-muted flex flex-wrap items-baseline gap-x-2 text-xs"
              >
                <span className="font-mono">{card.cardNumber}</span>
                <span>{MEMBERSHIP_CARD_REASON_LABELS[card.issueReason]}</span>
                <DateValue value={card.issuedOn} />
                <MembershipCardStatusBadge status={card.status} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
