'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { SelectField } from '@/components/clients/select-field';
import {
  COLLATERAL_ITEM_TYPES,
  COLLATERAL_ITEM_TYPE_LABELS,
  COLLATERAL_STATUS_DESCRIPTIONS,
  COLLATERAL_STATUS_LABELS,
  COLLATERAL_TYPES_WITH_SERIAL,
  type CollateralItemType,
} from '@/lib/domain/security';
import { formatRecordedDate } from '@/lib/domain/client';
import {
  realiseCollateralAction,
  recordCollateralAction,
  releaseCollateralAction,
  removeCollateralAction,
} from '@/lib/recovery/actions';
import type { CollateralItem } from '@/lib/data/security';
import type { ActionResult } from '@/lib/auth/actions';

/**
 * The security a loan is written against.
 *
 * ## Three different "stop" states, and why the panel shows all three
 *
 * An item is held, released or realised, and the panel keeps a released one on
 * the list rather than hiding it. A loan whose security was handed back in
 * March and which went into arrears in June is a specific story, and a panel
 * that showed only what is currently held would tell the wrong one.
 *
 * ## What the controls change, and what they do not
 *
 * Editing and removing are offered only while the application is being
 * assembled, because the database refuses them afterwards — the identity of
 * the item is what the business agreed to lend against. Releasing and
 * realising are offered on a live loan, because those are the only things
 * security is for.
 *
 * Realising records a sale. It does **not** reduce the loan: the proceeds are
 * banked through the payment screen like every other shilling, and the form
 * says so above the button, because a staff member who believes the balance
 * has already moved will not post the receipt.
 */
export function LoanCollateralPanel({
  loanId,
  items,
  editable,
  canManage,
  collateralRequired,
}: {
  readonly loanId: string;
  readonly items: readonly CollateralItem[];
  /** Is the loan still an application? Decides edit and remove, not release. */
  readonly editable: boolean;
  readonly canManage: boolean;
  readonly collateralRequired: boolean;
}) {
  const held = items.filter((item) => item.status === 'held');

  const coverHeld = held.reduce((sum, item) => sum + item.estimatedValue, 0);

  // Taken from the first row rather than summed: every row carries the same
  // loan's outstanding figure, and adding them up would multiply one debt by
  // the number of items pledged against it.
  const outstanding = items[0]?.totalOutstanding ?? null;

  return (
    <div className="min-w-0 space-y-4">
      {collateralRequired && held.length === 0 ? (
        <Alert tone="warning">
          This product expects security. Nothing is recorded as held against this loan.
        </Alert>
      ) : null}

      {held.length > 0 ? (
        <Card>
          <dl className="grid min-w-0 gap-4 sm:grid-cols-3">
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Items held</dt>
              <dd className="text-text text-xl font-semibold tabular-nums">
                {held.length}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Valued at</dt>
              <dd className="text-text text-xl font-semibold tabular-nums">
                <Money amount={coverHeld} />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Loan outstanding</dt>
              <dd className="text-text text-xl font-semibold tabular-nums">
                {outstanding === null ? '—' : <Money amount={outstanding} />}
              </dd>
            </div>
          </dl>

          <p className="text-text-muted mt-3 text-sm">
            A valuation is what somebody judged the item to be worth on a date. It is not
            a figure any balance is computed from, and realising an item reduces the loan
            only through the payment it produces.
          </p>
        </Card>
      ) : null}

      {items.length === 0 ? (
        <Card>
          <p className="text-text-muted">No security has been recorded on this loan.</p>
        </Card>
      ) : (
        <ul className="min-w-0 space-y-2">
          {items.map((item) => (
            <li key={item.id}>
              <CollateralRow
                loanId={loanId}
                item={item}
                editable={editable && canManage}
                canManage={canManage}
              />
            </li>
          ))}
        </ul>
      )}

      {canManage ? <RecordForm loanId={loanId} /> : null}
    </div>
  );
}

const STATUS_TONES = {
  held: 'info',
  released: 'neutral',
  realised: 'warning',
} as const;

function CollateralRow({
  loanId,
  item,
  editable,
  canManage,
}: {
  readonly loanId: string;
  readonly item: CollateralItem;
  readonly editable: boolean;
  readonly canManage: boolean;
}) {
  const [mode, setMode] = useState<'view' | 'release' | 'realise'>('view');

  return (
    <div className="border-border bg-surface min-w-0 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-text font-medium break-words">
            {COLLATERAL_ITEM_TYPE_LABELS[item.itemType]} — {item.description}
          </p>
          <p className="text-text-muted text-sm break-words">
            Valued at <Money amount={item.estimatedValue} /> on{' '}
            {formatRecordedDate(item.valuedOn)}
            {item.serialNumber === null ? '' : ` · ${item.serialNumber}`}
          </p>
          {item.location === null ? null : (
            <p className="text-text-muted text-sm break-words">Kept at {item.location}</p>
          )}
          {item.ownershipDocument === null ? null : (
            <p className="text-text-muted text-sm break-words">
              Ownership: {item.ownershipDocument}
            </p>
          )}
        </div>

        <Badge tone={STATUS_TONES[item.status]}>
          {COLLATERAL_STATUS_LABELS[item.status]}
        </Badge>
      </div>

      {item.status !== 'held' ? (
        <p className="text-text-muted mt-2 text-sm break-words">
          {COLLATERAL_STATUS_DESCRIPTIONS[item.status]}
          {item.realisedAmount === null ? null : (
            <>
              {' '}
              Fetched <Money amount={item.realisedAmount} />.
            </>
          )}
          {item.releaseReason === null ? '' : ` ${item.releaseReason}`}
        </p>
      ) : null}

      {item.status === 'held' && canManage ? (
        <div className="mt-3 min-w-0 space-y-3">
          {mode === 'view' ? (
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => {
                  setMode('release');
                }}
                className="text-brand-700 focus-visible:outline-accent min-h-11 text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                Release to the borrower
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('realise');
                }}
                className="text-brand-700 focus-visible:outline-accent min-h-11 text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                Record a sale
              </button>
              {editable ? <RemoveForm loanId={loanId} item={item} /> : null}
            </div>
          ) : null}

          {mode === 'release' ? (
            <ReleaseForm
              loanId={loanId}
              item={item}
              onCancel={() => {
                setMode('view');
              }}
            />
          ) : null}

          {mode === 'realise' ? (
            <RealiseForm
              loanId={loanId}
              item={item}
              onCancel={() => {
                setMode('view');
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RemoveForm({
  loanId,
  item,
}: {
  readonly loanId: string;
  readonly item: CollateralItem;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    removeCollateralAction,
    undefined,
  );

  return (
    <form action={formAction} className="min-w-0">
      <input type="hidden" name="loanId" value={loanId} />
      <input type="hidden" name="collateralId" value={item.id} />
      <button
        type="submit"
        disabled={pending}
        className="text-danger focus-visible:outline-accent min-h-11 text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
      >
        {pending ? 'Removing…' : 'Remove from the application'}
      </button>

      {state?.ok === false ? (
        <Alert tone="danger" className="mt-2">
          {state.message}
        </Alert>
      ) : null}
    </form>
  );
}

function ReleaseForm({
  loanId,
  item,
  onCancel,
}: {
  readonly loanId: string;
  readonly item: CollateralItem;
  readonly onCancel: () => void;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    releaseCollateralAction,
    undefined,
  );

  return (
    <form action={formAction} className="min-w-0 space-y-3" noValidate>
      <input type="hidden" name="loanId" value={loanId} />
      <input type="hidden" name="collateralId" value={item.id} />

      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      <Field
        label="Why it is being released"
        name="releaseReason"
        required
        hint="A guarantor or a borrower may ask about this years later."
        error={state?.fieldErrors?.releaseReason?.[0]}
      />

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Releasing…' : 'Release the item'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function RealiseForm({
  loanId,
  item,
  onCancel,
}: {
  readonly loanId: string;
  readonly item: CollateralItem;
  readonly onCancel: () => void;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    realiseCollateralAction,
    undefined,
  );

  return (
    <form action={formAction} className="min-w-0 space-y-3" noValidate>
      <input type="hidden" name="loanId" value={loanId} />
      <input type="hidden" name="collateralId" value={item.id} />

      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      <Alert tone="info">
        This records the sale only. Post the proceeds as a payment on the loan to reduce
        the balance — that is the entry the books and the borrower&apos;s statement are
        built from.
      </Alert>

      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Field
          label="What it fetched"
          name="realisedAmount"
          inputMode="numeric"
          required
          hint="Zero is a real answer. Record it rather than leaving the item held."
          error={state?.fieldErrors?.realisedAmount?.[0]}
        />
        <Field
          label="A note on the sale"
          name="releaseReason"
          required
          error={state?.fieldErrors?.releaseReason?.[0]}
        />
      </div>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Recording…' : 'Record the sale'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function RecordForm({ loanId }: { readonly loanId: string }) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    recordCollateralAction,
    undefined,
  );

  const [itemType, setItemType] = useState<CollateralItemType>('motorcycle');

  const wantsSerial = COLLATERAL_TYPES_WITH_SERIAL.includes(itemType);

  return (
    <Card className="min-w-0 space-y-3">
      <h3 className="text-text font-medium">Record security</h3>

      <form action={formAction} className="min-w-0 space-y-4" noValidate>
        <input type="hidden" name="loanId" value={loanId} />

        {state?.message !== undefined ? (
          <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
        ) : null}

        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <SelectField
            label="What kind of item"
            name="itemType"
            required
            defaultValue={itemType}
            options={COLLATERAL_ITEM_TYPES.map((value) => ({
              value,
              label: COLLATERAL_ITEM_TYPE_LABELS[value],
            }))}
            error={state?.fieldErrors?.itemType?.[0]}
            onValueChange={(value) => {
              setItemType(value as CollateralItemType);
            }}
          />

          <Field
            label="Description"
            name="description"
            required
            hint="Make, colour, condition — enough to identify it again."
            error={state?.fieldErrors?.description?.[0]}
          />

          <Field
            label="Estimated value"
            name="estimatedValue"
            inputMode="numeric"
            required
            error={state?.fieldErrors?.estimatedValue?.[0]}
          />

          <Field
            label="Valued on"
            name="valuedOn"
            type="date"
            required
            hint="A valuation with no date is a figure nobody can tell the age of."
            error={state?.fieldErrors?.valuedOn?.[0]}
          />

          {/* Offered where the item usually carries one. Still optional:
              a second-hand television's plate has often rubbed off. */}
          {wantsSerial ? (
            <Field
              label="Serial or registration number"
              name="serialNumber"
              error={state?.fieldErrors?.serialNumber?.[0]}
            />
          ) : null}

          <Field
            label="Ownership document"
            name="ownershipDocument"
            hint="Optional. A receipt, a logbook, a land title number."
            error={state?.fieldErrors?.ownershipDocument?.[0]}
          />

          <Field
            label="Where it is kept"
            name="location"
            hint="Optional. Useful when the business is not holding it."
            error={state?.fieldErrors?.location?.[0]}
          />
        </div>

        <Button type="submit" disabled={pending}>
          {pending ? 'Recording…' : 'Record the item'}
        </Button>
      </form>
    </Card>
  );
}
