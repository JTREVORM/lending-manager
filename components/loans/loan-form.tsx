'use client';

import { useActionState, useMemo, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { FormSection, FullWidth } from '@/components/clients/form-section';
import { SelectField } from '@/components/clients/select-field';
import { Money } from '@/components/ui/money';
import { LoanBreakdownTable } from './loan-breakdown-table';
import { createLoanAndRedirect, updateLoanDraftAction } from '@/lib/loans/actions';
import { calculateLoan } from '@/lib/domain/loan';
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

/**
 * A product, as the application form needs it.
 *
 * Everything the form uses to narrow itself: the amounts, the periods, the
 * cadences, the rate and whether it may be moved, and which further questions
 * the product asks. All of it read server-side from `loan_product_catalogue`;
 * none of it accepted from the browser.
 */
export interface ProductOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly isDefault: boolean;
  readonly minAmount: number;
  readonly maxAmount: number;
  readonly defaultInterestRateBps: number;
  readonly minInterestRateBps: number;
  readonly maxInterestRateBps: number;
  readonly interestMethod: string;
  readonly interestOverrideAllowed: boolean;
  readonly minTermMonths: number;
  readonly maxTermMonths: number;
  readonly allowedTermMonths: readonly number[] | null;
  readonly allowedRepaymentFrequencies: readonly string[];
  readonly defaultRepaymentFrequency: string;
  readonly guarantorRequired: boolean;
  readonly minGuarantors: number;
  readonly collateralRequired: boolean;
  readonly applicationProfile: string;
  readonly requiresSupportingDocuments: boolean;
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

const PROFILE_PROMPTS: Readonly<Record<string, string>> = {
  salary:
    'A salary loan. Once the draft is saved you will be asked for the employer, the job, the net salary and the day it is paid.',
  business:
    'A business loan. Once the draft is saved you will be asked for the business, what it turns over and what the money is for.',
  quick: 'A quick loan. No further questions beyond the terms below.',
  individual: 'An individual loan. The standard application.',
};

/**
 * Enter or edit a loan application.
 *
 * ## The product comes first, and everything narrows behind it
 *
 * A loan's terms are the product's terms. Choosing Salary Loan rather than
 * Quick Loan changes the permitted amounts, the available periods, the
 * cadences offered, the rate, how many guarantors the application needs and
 * which further questions it asks — so the product is the first control on
 * the form and the rest of the form is a function of it.
 *
 * None of that narrowing is a security control. `approve_loan` re-checks
 * every bound against the product at the moment of the decision, and refuses
 * a rate the product does not permit however it arrived. What the narrowing
 * buys is a staff member not entering a 90-day Quick Loan and discovering at
 * approval that no such thing exists.
 *
 * ## The preview, and why it recomputes in the browser
 *
 * As the amount, the period and the rate change, the breakdown below updates
 * immediately — computed by `lib/domain/loan.ts` in the browser. That is a
 * deliberate exception to "never trust browser arithmetic", and it is safe
 * for one reason: **nothing computed here is ever submitted.** The form posts
 * an amount, a period, a cadence and at most a proposed rate; the database
 * recomputes from the product at approval. The browser's figures reach no
 * database column.
 *
 * The parity test between the TypeScript engine and the SQL one is what makes
 * those figures trustworthy enough to say out loud to a borrower.
 */
export function LoanForm({
  loan,
  clients,
  frequencies,
  products,
  settings,
}: {
  readonly loan?: LoanDetail;
  readonly clients: readonly ClientOption[];
  readonly frequencies: readonly FrequencyOption[];
  readonly products: readonly ProductOption[];
  readonly settings: LoanFormSettings;
}) {
  const editing = loan !== undefined;

  const [state, formAction, pending] = useActionState<
    LoanActionResult | ActionResult | undefined,
    FormData
  >(editing ? updateLoanDraftAction : createLoanAndRedirect, undefined);

  const initialProductId =
    loan?.productId ??
    products.find((product) => product.isDefault)?.id ??
    products[0]?.id ??
    '';

  const [productId, setProductId] = useState(initialProductId);
  const [principalText, setPrincipalText] = useState(
    editing ? String(loan.principalAmount) : '',
  );
  const [termMonths, setTermMonths] = useState(
    editing ? String(loan.loanTermMonths) : '1',
  );
  const [rateText, setRateText] = useState(
    editing && loan.proposedInterestRateBps !== null
      ? String(loan.proposedInterestRateBps)
      : '',
  );

  const product = useMemo(
    () => products.find((candidate) => candidate.id === productId),
    [products, productId],
  );

  const principal = useMemo(() => {
    const cleaned = principalText.replace(/[\s,]/g, '');
    if (!/^\d+$/.test(cleaned)) return null;
    const value = Number(cleaned);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }, [principalText]);

  /**
   * The periods this product offers.
   *
   * `allowed_term_months` is an explicit list where the product has one — a
   * Quick Loan that runs for 1 or 3 months and nothing between. Where it is
   * null the product offers a range, and the business-wide multi-month
   * threshold still narrows it: a longer period becomes *available* at or
   * above an amount, which is the confirmed rule.
   */
  const availableTerms = useMemo(() => {
    if (product === undefined) return [1];

    if (product.allowedTermMonths !== null && product.allowedTermMonths.length > 0) {
      return [...product.allowedTermMonths].sort((a, b) => a - b);
    }

    const ceiling =
      (principal ?? 0) >= settings.multiMonthMinAmount ? product.maxTermMonths : 1;

    const terms: number[] = [];
    for (
      let months = Math.max(1, product.minTermMonths);
      months <= ceiling;
      months += 1
    ) {
      terms.push(months);
    }

    return terms.length > 0 ? terms : [1];
  }, [product, principal, settings.multiMonthMinAmount]);

  const availableFrequencies = useMemo(() => {
    if (product === undefined) return frequencies;

    const permitted = new Set(product.allowedRepaymentFrequencies);
    const offered = frequencies.filter((frequency) => permitted.has(frequency.key));

    // A product whose cadences are all inactive would otherwise leave the
    // select empty and the form unsubmittable with no explanation.
    return offered.length > 0 ? offered : frequencies;
  }, [product, frequencies]);

  const proposedRateBps = useMemo(() => {
    const cleaned = rateText.trim();
    if (cleaned === '') return product?.defaultInterestRateBps ?? null;
    if (!/^\d+$/.test(cleaned)) return null;
    return Number(cleaned);
  }, [rateText, product]);

  /**
   * The preview.
   *
   * `calculateLoan` throws on invalid input rather than returning a partial
   * result, which is right for a financial engine and means this has to catch:
   * a half-typed amount is not an error, it is somebody still typing.
   */
  const preview = useMemo(() => {
    if (principal === null || proposedRateBps === null) return null;

    const months = Number(termMonths);

    if (!Number.isInteger(months) || months < 1) return null;
    if (!availableTerms.includes(months)) return null;

    try {
      return calculateLoan({
        principal: toUgx(principal),
        monthlyInterestRateBps: proposedRateBps,
        termMonths: months,
      });
    } catch {
      return null;
    }
  }, [principal, termMonths, availableTerms, proposedRateBps]);

  const fieldError = (name: string): string | undefined =>
    state?.fieldErrors?.[name]?.[0];

  const belowMinimum =
    principal !== null && product !== undefined && principal < product.minAmount;
  const aboveMaximum =
    principal !== null && product !== undefined && principal > product.maxAmount;

  const rateOutOfRange =
    product !== undefined &&
    rateText.trim() !== '' &&
    proposedRateBps !== null &&
    (proposedRateBps < product.minInterestRateBps ||
      proposedRateBps > product.maxInterestRateBps);

  return (
    <div className="min-w-0 space-y-5">
      <form action={formAction} className="space-y-4" noValidate>
        {state?.message !== undefined ? (
          <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
        ) : null}

        {editing ? <input type="hidden" name="loanId" value={loan.id} /> : null}

        {/* --- 1. The product ------------------------------------------- */}
        <FormSection
          title="Loan product"
          description="Choose what the borrower is applying for. The amounts, periods and rate below are the product's."
        >
          <FullWidth>
            <SelectField
              label="Loan product"
              name="loanProductId"
              required
              defaultValue={initialProductId}
              options={products.map((candidate) => ({
                value: candidate.id,
                label: `${candidate.name} (${candidate.code})`,
              }))}
              error={fieldError('loanProductId')}
              onValueChange={setProductId}
            />
          </FullWidth>

          {product !== undefined ? (
            <FullWidth>
              <div className="border-border bg-surface-sunken min-w-0 space-y-2 rounded-lg border p-3">
                {product.description !== null ? (
                  <p className="text-text text-sm">{product.description}</p>
                ) : null}
                <p className="text-text-muted text-sm">
                  {PROFILE_PROMPTS[product.applicationProfile] ??
                    'The standard application.'}
                </p>
                <dl className="grid min-w-0 gap-2 text-sm sm:grid-cols-2">
                  <ProductFact label="Amount">
                    <Money amount={toUgx(product.minAmount)} /> –{' '}
                    <Money amount={toUgx(product.maxAmount)} />
                  </ProductFact>
                  <ProductFact label="Standard rate">
                    {formatBps(toBps(product.defaultInterestRateBps))} per month
                  </ProductFact>
                  <ProductFact label="Guarantors">
                    {product.minGuarantors === 0
                      ? 'None required by this product'
                      : `At least ${String(product.minGuarantors)}`}
                  </ProductFact>
                  <ProductFact label="Security">
                    {product.collateralRequired ? 'Collateral required' : 'Not required'}
                  </ProductFact>
                </dl>
              </div>
            </FullWidth>
          ) : null}
        </FormSection>

        {/* --- 2. The borrower ------------------------------------------ */}
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

        {/* --- 3. Amount and period ------------------------------------- */}
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
            hint={
              product === undefined
                ? 'Whole shillings.'
                : `Whole shillings. ${formatUgx(toUgx(product.minAmount))} to ${formatUgx(toUgx(product.maxAmount))}.`
            }
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
              product?.allowedTermMonths !== null &&
              product?.allowedTermMonths !== undefined
                ? 'The periods this product offers.'
                : principal !== null && principal < settings.multiMonthMinAmount
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
            defaultValue={
              loan?.repaymentFrequency ??
              product?.defaultRepaymentFrequency ??
              settings.defaultRepaymentFrequency
            }
            options={availableFrequencies.map((frequency) => ({
              value: frequency.key,
              label: frequency.label,
            }))}
            hint="How often the borrower pays. The collection dates are generated at disbursement."
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

          {/*
            Only where the product permits it. A disabled control would say
            "you may not do this"; its absence says "this product has one
            rate", which is the truth.
          */}
          {product?.interestOverrideAllowed === true ? (
            <Field
              label="Proposed monthly rate"
              name="proposedInterestRateBps"
              inputMode="numeric"
              value={rateText}
              onChange={(event) => {
                setRateText(event.target.value);
              }}
              hint={`In basis points. Leave blank for the standard ${formatBps(toBps(product.defaultInterestRateBps))}. Permitted: ${formatBps(toBps(product.minInterestRateBps))} to ${formatBps(toBps(product.maxInterestRateBps))}.`}
              error={fieldError('proposedInterestRateBps')}
            />
          ) : null}
        </FormSection>

        {belowMinimum && product !== undefined ? (
          <Alert tone="warning">
            <Money amount={toUgx(principal)} /> is below {product.name}&rsquo;s minimum of{' '}
            <Money amount={toUgx(product.minAmount)} />.
          </Alert>
        ) : null}

        {aboveMaximum && product !== undefined ? (
          <Alert tone="warning">
            <Money amount={toUgx(principal)} /> is above {product.name}&rsquo;s maximum of{' '}
            <Money amount={toUgx(product.maxAmount)} />.
          </Alert>
        ) : null}

        {rateOutOfRange && product !== undefined ? (
          <Alert tone="warning">
            {product.name} permits {formatBps(toBps(product.minInterestRateBps))} to{' '}
            {formatBps(toBps(product.maxInterestRateBps))} a month. Approval will refuse a
            rate outside that.
          </Alert>
        ) : null}

        {/* --- 4. Notes -------------------------------------------------- */}
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
                : 'Start application'}
          </Button>
        </div>

        {!editing ? (
          <p className="text-text-muted text-sm">
            Saving the draft issues a loan number. The guarantors, the documents and any
            further questions this product asks are entered on the application page that
            follows.
          </p>
        ) : null}
      </form>

      <section aria-labelledby="preview-heading" className="min-w-0 space-y-3">
        <h2 id="preview-heading" className="text-text text-lg font-semibold">
          Calculation
        </h2>
        <p className="text-text-muted text-sm">
          Reducing balance at{' '}
          {formatBps(toBps(proposedRateBps ?? settings.defaultMonthlyInterestRateBps))}{' '}
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

function ProductFact({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-text">{children}</dd>
    </div>
  );
}
