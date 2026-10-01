'use client';

import { useActionState, useMemo, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { FormSection, FullWidth } from '@/components/clients/form-section';
import { SelectField } from '@/components/clients/select-field';
import { LoanBreakdownTable } from './loan-breakdown-table';
import { createLoanAndRedirect, updateLoanDraftAction } from '@/lib/loans/actions';
import { calculateLoan, permittedTermMonths } from '@/lib/domain/loan';
import { formatUgx, toUgx } from '@/lib/domain/money';
import { formatBps, toBps } from '@/lib/domain/rate';
import type { LoanDetail } from '@/lib/data/loans';
import type { ActionResult } from '@/lib/auth/actions';
import type { LoanActionResult } from '@/lib/loans/actions';

export interface LoanFormSettings {
  readonly defaultMonthlyInterestRateBps: number;
  readonly minLoanAmount: number;
  readonly maxLoanAmount: number | null;
  readonly minLoanTermMonths: number;
  readonly maxLoanTermMonths: number;
  readonly multiMonthMinAmount: number;
  readonly defaultRepaymentFrequency: string;
}

export interface ClientOption {
  readonly id: string;
  readonly label: string;
  readonly hasActiveLoan: boolean;
}

export interface FrequencyOption {
  readonly key: string;
  readonly label: string;
}

/**
 * Enter or edit a loan.
 *
 * ## The preview, and why it recomputes in the browser
 *
 * As the amount and period change, the breakdown below updates immediately —
 * computed by `lib/domain/loan.ts` in the browser. That is a deliberate
 * exception to "never trust browser arithmetic", and it is safe for one
 * reason: **nothing computed here is ever submitted.** The form posts an
 * amount, a period and a frequency; the server recomputes from the settings it
 * reads itself, and the database recomputes again at approval. The browser's
 * figures reach no database column.
 *
 * What the preview buys is a staff member being able to tell a borrower what
 * three months would cost before committing to it, without a round trip per
 * keystroke. The parity test between the TypeScript engine and the SQL one is
 * what makes those figures trustworthy enough to say out loud.
 *
 * The preview is labelled provisional throughout, because the approving
 * settings may differ from today's — see `LoanBreakdownTable`.
 *
 * ## The term options narrow with the amount
 *
 * The confirmed rule is that a multi-month term becomes *available* at or
 * above a threshold. So the period select offers one month below it and the
 * full range at or above it, recomputed as the amount is typed. The server
 * and the database both check this again.
 */
export function LoanForm({
  loan,
  clients,
  frequencies,
  settings,
}: {
  readonly loan?: LoanDetail;
  readonly clients: readonly ClientOption[];
  readonly frequencies: readonly FrequencyOption[];
  readonly settings: LoanFormSettings;
}) {
  const editing = loan !== undefined;

  const [state, formAction, pending] = useActionState<
    LoanActionResult | ActionResult | undefined,
    FormData
  >(editing ? updateLoanDraftAction : createLoanAndRedirect, undefined);

  const [principalText, setPrincipalText] = useState(
    editing ? String(loan.principalAmount) : '',
  );
  const [termMonths, setTermMonths] = useState(
    editing ? String(loan.loanTermMonths) : '1',
  );

  const principal = useMemo(() => {
    const cleaned = principalText.replace(/[\s,]/g, '');
    if (!/^\d+$/.test(cleaned)) return null;
    const value = Number(cleaned);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }, [principalText]);

  const availableTerms = useMemo(
    () =>
      permittedTermMonths(toUgx(principal ?? 0), {
        minTermMonths: settings.minLoanTermMonths,
        maxTermMonths: settings.maxLoanTermMonths,
        multiMonthMinAmount: settings.multiMonthMinAmount,
      }),
    [principal, settings],
  );

  /**
   * The preview.
   *
   * `calculateLoan` throws on invalid input rather than returning a partial
   * result, which is right for a financial engine and means this has to catch:
   * a half-typed amount is not an error, it is somebody still typing.
   */
  const preview = useMemo(() => {
    if (principal === null) return null;

    const months = Number(termMonths);

    if (!Number.isInteger(months) || months < 1) return null;
    if (!availableTerms.includes(months)) return null;

    try {
      return calculateLoan({
        principal: toUgx(principal),
        monthlyInterestRateBps: settings.defaultMonthlyInterestRateBps,
        termMonths: months,
      });
    } catch {
      return null;
    }
  }, [principal, termMonths, availableTerms, settings]);

  const fieldError = (name: string): string | undefined =>
    state?.fieldErrors?.[name]?.[0];

  const belowMinimum = principal !== null && principal < settings.minLoanAmount;

  return (
    <div className="min-w-0 space-y-5">
      <form action={formAction} className="space-y-4" noValidate>
        {state?.message !== undefined ? (
          <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
        ) : null}

        {editing ? <input type="hidden" name="loanId" value={loan.id} /> : null}

        <FormSection
          title="Borrower"
          description="Only an active client with no outstanding loan can take a new one."
        >
          <FullWidth>
            <SelectField
              label="Client"
              name="clientId"
              required
              defaultValue={loan?.clientId}
              options={[
                { value: '', label: 'Select a client…' },
                ...clients.map((client) => ({
                  value: client.id,
                  // Flagged rather than hidden: a staff member looking for
                  // somebody needs to know why they cannot be chosen.
                  label: client.hasActiveLoan
                    ? `${client.label} — has an active loan`
                    : client.label,
                })),
              ]}
              error={fieldError('clientId')}
            />
          </FullWidth>
        </FormSection>

        <FormSection title="Amount and period">
          <Field
            label="Loan amount"
            name="principalAmount"
            inputMode="numeric"
            required
            value={principalText}
            onChange={(event) => {
              setPrincipalText(event.target.value);
            }}
            hint={`Whole shillings. Minimum ${formatUgx(toUgx(settings.minLoanAmount))}.`}
            error={fieldError('principalAmount')}
          />

          <SelectField
            label="Loan period"
            name="loanTermMonths"
            required
            defaultValue={termMonths}
            options={availableTerms.map((months) => ({
              value: String(months),
              label: months === 1 ? '1 month' : `${String(months)} months`,
            }))}
            hint={
              principal !== null && principal < settings.multiMonthMinAmount
                ? `A longer period becomes available at ${formatUgx(toUgx(settings.multiMonthMinAmount))}.`
                : 'Interest reduces each month as the balance falls.'
            }
            error={fieldError('loanTermMonths')}
            onValueChange={setTermMonths}
          />

          <SelectField
            label="Repayment frequency"
            name="repaymentFrequency"
            required
            defaultValue={loan?.repaymentFrequency ?? settings.defaultRepaymentFrequency}
            options={frequencies.map((frequency) => ({
              value: frequency.key,
              label: frequency.label,
            }))}
            hint="How often the borrower pays. The collection dates are generated in a later phase."
            error={fieldError('repaymentFrequency')}
          />

          <Field
            label="Intended disbursement date"
            name="proposedDisbursementDate"
            type="date"
            required
            defaultValue={loan?.proposedDisbursementDate}
            hint="When the business expects to hand over the money."
            error={fieldError('proposedDisbursementDate')}
          />
        </FormSection>

        {belowMinimum ? (
          <Alert tone="warning">
            {formatUgx(toUgx(principal))} is below the current minimum of{' '}
            {formatUgx(toUgx(settings.minLoanAmount))}.
          </Alert>
        ) : null}

        <FormSection title="Notes">
          <FullWidth>
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="loan-notes">Notes</Label>
              <textarea
                id="loan-notes"
                name="notes"
                rows={3}
                maxLength={2000}
                defaultValue={loan?.notes ?? ''}
                className="border-border bg-surface text-text focus-visible:outline-accent w-full rounded-lg border p-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2"
              />
              <p className="text-text-muted text-sm">
                Optional. Anything the reviewer should know.
              </p>
            </div>
          </FullWidth>
        </FormSection>

        <div className="flex flex-col gap-3 sm:flex-row-reverse">
          <Button type="submit" disabled={pending} className="sm:w-auto">
            {pending
              ? editing
                ? 'Saving…'
                : 'Starting…'
              : editing
                ? 'Save draft'
                : 'Start loan draft'}
          </Button>
        </div>
      </form>

      <section aria-labelledby="preview-heading" className="min-w-0 space-y-3">
        <h2 id="preview-heading" className="text-text text-lg font-semibold">
          Calculation
        </h2>
        <p className="text-text-muted text-sm">
          Reducing balance at {formatBps(toBps(settings.defaultMonthlyInterestRateBps))}{' '}
          per month on the opening balance.
        </p>

        <LoanBreakdownTable
          periods={preview?.periods ?? []}
          principal={preview?.principal ?? 0}
          totalInterest={preview?.totalInterest ?? 0}
          totalExpected={preview?.totalExpectedRepayment ?? 0}
          provisional
        />
      </section>
    </div>
  );
}
