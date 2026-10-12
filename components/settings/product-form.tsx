'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { FormSection, FullWidth } from '@/components/clients/form-section';
import { SelectField } from '@/components/clients/select-field';
import {
  APPLICATION_PROFILES,
  APPLICATION_PROFILE_HINTS,
  APPLICATION_PROFILE_LABELS,
  EARLY_REPAYMENT_LABELS,
  EARLY_REPAYMENT_OPTIONS,
  EXTRA_PAYMENT_LABELS,
  EXTRA_PAYMENT_OPTIONS,
  INTEREST_METHODS,
  INTEREST_METHOD_LABELS,
  PENALTY_METHODS,
  PENALTY_METHOD_LABELS,
  PRODUCT_STATUSES,
  PRODUCT_STATUS_LABELS,
  type LoanProduct,
} from '@/lib/domain/loan-product';
import { ROLES, ROLE_KEYS } from '@/lib/permissions';
import { bpsToPercent, toBps } from '@/lib/domain/rate';
import {
  createLoanProductAction,
  updateLoanProductAction,
  type ProductActionResult,
} from '@/lib/products/actions';
import type { BranchOption, CadenceOption } from '@/lib/data/products';

export interface ProductFormProps {
  /** Absent when creating. Present when editing, and then the code is fixed. */
  readonly product?: LoanProduct;
  readonly branches: readonly BranchOption[];
  readonly cadences: readonly CadenceOption[];
}

/**
 * Creating or changing a loan product.
 *
 * ## One form for both
 *
 * The fields are identical and the rules are identical; only the code field
 * differs — fixed once a product exists, because it appears on every snapshot
 * and export and renaming it would relabel history. Two forms would be two
 * places to add the next field to, and the one left out would be the one that
 * mattered.
 *
 * ## What it does not pretend to decide
 *
 * The guard rail — what `business_settings` permits — is enforced by a
 * trigger inside the transaction, so a product that exceeds the business
 * maximum is refused there and the refusal is shown here in full. This form
 * does not re-check it, because the check would be against a row read a
 * moment earlier and a form that passed its own check and was then refused
 * is worse than one that simply reports the refusal.
 *
 * ## The one thing it says out loud
 *
 * That changing a product changes nothing already agreed. It is the single
 * most important sentence on the screen: an Owner dropping a rate has to know
 * it applies to loans approved from now on, and an Owner raising one has to
 * know it does not reach back.
 */
export function ProductForm({ product, branches, cadences }: ProductFormProps) {
  const editing = product !== undefined;

  const [result, submit, pending] = useActionState<
    ProductActionResult | undefined,
    FormData
  >(editing ? updateLoanProductAction : createLoanProductAction, undefined);

  // Two controls read their own state, because each gates the meaning of
  // another field: naming who may change the rate is meaningless unless
  // changing it is permitted, and a count of guarantors is meaningless unless
  // one is required. The database says the same thing with CHECK
  // constraints; this stops a person submitting a contradiction to find out.
  const [overrideAllowed, setOverrideAllowed] = useState(
    product?.interestOverrideAllowed ?? false,
  );
  const [guarantorRequired, setGuarantorRequired] = useState(
    product?.guarantorRequired ?? false,
  );

  const errors = result?.fieldErrors ?? {};
  const percent = (bps: number | undefined, fallback: string): string =>
    bps === undefined ? fallback : String(bpsToPercent(toBps(bps)));

  if (result?.ok === true) {
    return <Alert tone="success">{result.message}</Alert>;
  }

  return (
    <form action={submit} className="min-w-0 space-y-4">
      {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}

      {editing ? (
        <input type="hidden" name="productId" value={product.productId} />
      ) : null}

      <Alert tone="info" title="A change here does not change an existing loan">
        Every loan records the product&apos;s terms at the moment it is approved, and
        figures never move afterwards. What you set here applies to loans approved{' '}
        <strong>after</strong> you save it.
      </Alert>

      {/* --- Identity --------------------------------------------------- */}
      <FormSection
        title="The product"
        description="What staff will see in the application, and where it sits in the list."
      >
        <Field
          label="Product name"
          name="name"
          required
          defaultValue={product?.name ?? ''}
          error={errors.name?.[0]}
          hint="For example Salary Loans."
        />

        {editing ? (
          <Field
            label="Product code"
            name="productCodeDisplay"
            defaultValue={product.productCode}
            disabled
            hint="Fixed. It appears on every approved loan's snapshot, so it cannot be renamed."
          />
        ) : (
          <Field
            label="Product code"
            name="productCode"
            required
            error={errors.productCode?.[0]}
            hint="Short and upper case, for example SL. Used on exports and reports, and fixed once saved."
          />
        )}

        <FullWidth>
          <Field
            label="Description"
            name="description"
            defaultValue={product?.description ?? ''}
            error={errors.description?.[0]}
            hint="One or two sentences a loan officer can read when choosing."
          />
        </FullWidth>

        <SelectField
          label="Offered"
          name="status"
          required
          defaultValue={product?.status ?? 'active'}
          error={errors.status?.[0]}
          options={PRODUCT_STATUSES.map((status) => ({
            value: status,
            label: PRODUCT_STATUS_LABELS[status],
          }))}
          hint="A withdrawn product keeps its existing loans and cannot be chosen for a new application."
        />

        <Field
          label="Display order"
          name="sortOrder"
          required
          inputMode="numeric"
          defaultValue={String(product?.sortOrder ?? 100)}
          error={errors.sortOrder?.[0]}
          hint="Lower appears first. The business orders its products by how it sells them."
        />

        <FullWidth>
          <Checkbox
            name="isDefault"
            label="The default product"
            defaultChecked={product?.isDefault ?? false}
            hint="Used when a loan is created without naming a product. Only one product can be the default, and setting this moves it."
          />
        </FullWidth>
      </FormSection>

      {/* --- Amount ----------------------------------------------------- */}
      <FormSection
        title="Amount"
        description="The range this product lends, inside what the business permits."
      >
        <Field
          label="Smallest loan"
          name="minAmount"
          required
          inputMode="numeric"
          defaultValue={product === undefined ? '' : String(product.minAmount)}
          error={errors.minAmount?.[0]}
          hint="Whole shillings, for example 100000."
        />
        <Field
          label="Largest loan"
          name="maxAmount"
          required
          inputMode="numeric"
          defaultValue={product === undefined ? '' : String(product.maxAmount)}
          error={errors.maxAmount?.[0]}
          hint="Cannot exceed the business maximum in Lending rules."
        />
      </FormSection>

      {/* --- Interest --------------------------------------------------- */}
      <FormSection
        title="Interest"
        description="The standard monthly rate, and the band inside which it may be varied."
      >
        <Field
          label="Standard monthly rate (%)"
          name="defaultInterestRate"
          required
          inputMode="decimal"
          defaultValue={percent(product?.defaultInterestRateBps, '')}
          error={errors.defaultInterestRateBps?.[0]}
          hint="What a loan is priced at unless somebody with the authority decides otherwise."
        />
        <SelectField
          label="How interest is charged"
          name="interestMethod"
          required
          defaultValue={product?.interestMethod ?? 'reducing_balance_monthly'}
          error={errors.interestMethod?.[0]}
          options={INTEREST_METHODS.map((method) => ({
            value: method,
            label: INTEREST_METHOD_LABELS[method],
          }))}
        />
        <Field
          label="Lowest permitted rate (%)"
          name="minInterestRate"
          required
          inputMode="decimal"
          defaultValue={percent(product?.minInterestRateBps, '')}
          error={errors.minInterestRateBps?.[0]}
        />
        <Field
          label="Highest permitted rate (%)"
          name="maxInterestRate"
          required
          inputMode="decimal"
          defaultValue={percent(product?.maxInterestRateBps, '')}
          error={errors.maxInterestRateBps?.[0]}
        />

        <FullWidth>
          <Checkbox
            name="interestOverrideAllowed"
            label="A different rate may be approved"
            defaultChecked={product?.interestOverrideAllowed ?? false}
            onChange={setOverrideAllowed}
            hint="Within the band above, and only by the roles named below."
          />
        </FullWidth>

        {overrideAllowed ? (
          <FullWidth>
            <fieldset className="min-w-0">
              <legend className="text-text mb-1.5 text-sm font-medium">
                Who may approve a different rate
              </legend>
              <div className="flex min-w-0 flex-wrap gap-x-5 gap-y-2">
                {/* Staff roles only. A borrower cannot approve anything, and
                    offering the role here would be offering a contradiction. */}
                {ROLE_KEYS.filter((key) => ROLES[key].isStaff).map((key) => (
                  <label
                    key={key}
                    className="text-text flex items-center gap-2 text-sm"
                    htmlFor={`override-${key}`}
                  >
                    <input
                      id={`override-${key}`}
                      type="checkbox"
                      name="interestOverrideRoles"
                      value={key}
                      defaultChecked={
                        product?.interestOverrideRoles.includes(key) ?? false
                      }
                      className="accent-accent size-4"
                    />
                    {ROLES[key].label}
                  </label>
                ))}
              </div>
              {errors.interestOverrideRoles?.[0] === undefined ? null : (
                <p role="alert" className="text-danger mt-1.5 text-sm">
                  {errors.interestOverrideRoles[0]}
                </p>
              )}
            </fieldset>
          </FullWidth>
        ) : null}
      </FormSection>

      {/* --- Duration and cadence --------------------------------------- */}
      <FormSection
        title="Duration and repayment"
        description="How long the loan runs, and how often the borrower pays."
      >
        <Field
          label="Shortest duration (months)"
          name="minTermMonths"
          required
          inputMode="numeric"
          defaultValue={String(product?.minTermMonths ?? 1)}
          error={errors.minTermMonths?.[0]}
        />
        <Field
          label="Longest duration (months)"
          name="maxTermMonths"
          required
          inputMode="numeric"
          defaultValue={String(product?.maxTermMonths ?? 3)}
          error={errors.maxTermMonths?.[0]}
        />

        <FullWidth>
          <Field
            label="Only these durations (optional)"
            name="allowedTermMonths"
            defaultValue={product?.allowedTermMonths?.join(', ') ?? ''}
            error={errors.allowedTermMonths?.[0]}
            hint="A fixed menu, for example 1, 2, 3. Leave blank to allow any whole month in the range above."
          />
        </FullWidth>

        <FullWidth>
          <fieldset className="min-w-0">
            <legend className="text-text mb-1.5 text-sm font-medium">
              Repayment cadences offered
            </legend>
            {cadences.length === 0 ? (
              <p className="text-text-muted text-sm">
                No active repayment cadences could be read, so none can be chosen.
              </p>
            ) : (
              <div className="flex min-w-0 flex-wrap gap-x-5 gap-y-2">
                {cadences.map((cadence) => (
                  <label
                    key={cadence.key}
                    className="text-text flex items-center gap-2 text-sm"
                    htmlFor={`cadence-${cadence.key}`}
                  >
                    <input
                      id={`cadence-${cadence.key}`}
                      type="checkbox"
                      name="allowedRepaymentFrequencies"
                      value={cadence.key}
                      defaultChecked={
                        product?.allowedRepaymentFrequencies.includes(cadence.key) ?? true
                      }
                      className="accent-accent size-4"
                    />
                    {cadence.label}
                  </label>
                ))}
              </div>
            )}
            {errors.allowedRepaymentFrequencies?.[0] === undefined ? null : (
              <p role="alert" className="text-danger mt-1.5 text-sm">
                {errors.allowedRepaymentFrequencies[0]}
              </p>
            )}
          </fieldset>
        </FullWidth>

        <SelectField
          label="Default cadence"
          name="defaultRepaymentFrequency"
          required
          defaultValue={product?.defaultRepaymentFrequency ?? cadences[0]?.key ?? ''}
          error={errors.defaultRepaymentFrequency?.[0]}
          options={cadences.map((cadence) => ({
            value: cadence.key,
            label: cadence.label,
          }))}
          hint="Has to be one of the cadences ticked above."
        />
      </FormSection>

      {/* --- Lateness --------------------------------------------------- */}
      <FormSection
        title="Late payment"
        description="What happens after the final collection date passes unpaid."
      >
        <Field
          label="Grace period (days)"
          name="gracePeriodDays"
          required
          inputMode="numeric"
          defaultValue={String(product?.gracePeriodDays ?? 3)}
          error={errors.gracePeriodDays?.[0]}
          hint="Days after the final collection date before a charge may apply."
        />
        <Field
          label="Late-payment charge (%)"
          name="penaltyRate"
          required
          inputMode="decimal"
          defaultValue={percent(product?.penaltyRateBps, '')}
          error={errors.penaltyRateBps?.[0]}
          hint="Of the balance outstanding when the grace period ends."
        />
        <SelectField
          label="How the charge is worked out"
          name="penaltyMethod"
          required
          defaultValue={product?.penaltyMethod ?? 'one_time_percent_of_outstanding'}
          error={errors.penaltyMethod?.[0]}
          options={PENALTY_METHODS.map((method) => ({
            value: method,
            label: PENALTY_METHOD_LABELS[method],
          }))}
        />
      </FormSection>

      {/* --- Security --------------------------------------------------- */}
      <FormSection
        title="Security"
        description="What the business asks for before it lends."
      >
        <Checkbox
          name="guarantorRequired"
          label="A guarantor is required"
          defaultChecked={product?.guarantorRequired ?? false}
          onChange={setGuarantorRequired}
        />
        <Field
          label="Guarantors required"
          name="minGuarantors"
          required
          inputMode="numeric"
          defaultValue={String(product?.minGuarantors ?? 0)}
          error={errors.minGuarantors?.[0]}
          hint={
            guarantorRequired
              ? 'At least one, since a guarantor is required.'
              : 'Zero, unless a guarantor is required.'
          }
        />
        <Checkbox
          name="collateralRequired"
          label="Collateral is required"
          defaultChecked={product?.collateralRequired ?? false}
        />
      </FormSection>

      {/* --- Repayment behaviour ---------------------------------------- */}
      <FormSection
        title="Settling early, and paying extra"
        description="The two things a borrower does that the schedule did not plan for."
      >
        <SelectField
          label="Settling early"
          name="earlyRepayment"
          required
          defaultValue={product?.earlyRepayment ?? 'allowed_no_rebate'}
          error={errors.earlyRepayment?.[0]}
          options={EARLY_REPAYMENT_OPTIONS.map((option) => ({
            value: option,
            label: EARLY_REPAYMENT_LABELS[option],
          }))}
        />
        <SelectField
          label="Paying more than asked"
          name="extraPayment"
          required
          defaultValue={product?.extraPayment ?? 'reduces_balance'}
          error={errors.extraPayment?.[0]}
          options={EXTRA_PAYMENT_OPTIONS.map((option) => ({
            value: option,
            label: EXTRA_PAYMENT_LABELS[option],
          }))}
        />
      </FormSection>

      {/* --- The application -------------------------------------------- */}
      <FormSection
        title="The application"
        description="Which questions a loan officer is asked when they choose this product."
      >
        <SelectField
          label="Questions asked"
          name="applicationProfile"
          required
          defaultValue={product?.applicationProfile ?? 'individual'}
          error={errors.applicationProfile?.[0]}
          options={APPLICATION_PROFILES.map((profile) => ({
            value: profile,
            label: APPLICATION_PROFILE_LABELS[profile],
          }))}
          hint={
            APPLICATION_PROFILE_HINTS[
              (product?.applicationProfile ??
                'individual') as keyof typeof APPLICATION_PROFILE_HINTS
            ]
          }
        />
        <Checkbox
          name="requiresSupportingDocuments"
          label="Supporting documents before submission"
          defaultChecked={product?.requiresSupportingDocuments ?? true}
          hint="Turning this off shortens the application. It does not weaken approval: every check still applies."
        />
      </FormSection>

      {/* --- Availability ----------------------------------------------- */}
      <FormSection
        title="Where it is sold"
        description="Leave every branch unticked to offer it everywhere."
      >
        <FullWidth>
          {branches.length === 0 ? (
            <p className="text-text-muted text-sm">
              No branches could be read, so this product will be offered everywhere.
            </p>
          ) : (
            <div className="flex min-w-0 flex-wrap gap-x-5 gap-y-2">
              {branches.map((branch) => (
                <label
                  key={branch.id}
                  className="text-text flex items-center gap-2 text-sm"
                  htmlFor={`branch-${branch.id}`}
                >
                  <input
                    id={`branch-${branch.id}`}
                    type="checkbox"
                    name="branchIds"
                    value={branch.id}
                    defaultChecked={product?.branchIds?.includes(branch.id) ?? false}
                    className="accent-accent size-4"
                  />
                  <span className="font-mono text-xs">{branch.branchCode}</span>
                  {branch.name}
                </label>
              ))}
            </div>
          )}
        </FullWidth>
      </FormSection>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" loading={pending}>
          {editing ? 'Save product' : 'Create product'}
        </Button>
      </div>
    </form>
  );
}

/**
 * A checkbox with its label and hint.
 *
 * `Field` wraps an `input` whose value is its text, which a checkbox's is
 * not — the browser sends `on` or nothing at all. Rather than loosen `Field`,
 * this is the four lines a checkbox actually needs.
 */
function Checkbox({
  name,
  label,
  defaultChecked,
  hint,
  onChange,
}: {
  readonly name: string;
  readonly label: string;
  readonly defaultChecked: boolean;
  readonly hint?: string;
  readonly onChange?: (checked: boolean) => void;
}) {
  return (
    <div className="min-w-0">
      <label
        className="text-text flex items-start gap-2 text-sm"
        htmlFor={`check-${name}`}
      >
        <input
          id={`check-${name}`}
          type="checkbox"
          name={name}
          defaultChecked={defaultChecked}
          onChange={
            onChange === undefined
              ? undefined
              : (event) => {
                  onChange(event.target.checked);
                }
          }
          className="accent-accent mt-0.5 size-4 shrink-0"
        />
        <span className="font-medium">{label}</span>
      </label>
      {hint === undefined ? null : <p className="text-text-muted mt-1 text-xs">{hint}</p>}
    </div>
  );
}
