'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { FormSection, FullWidth } from '@/components/clients/form-section';
import { bpsToPercent, toBps } from '@/lib/domain/rate';
import {
  updateFinanceSettingsAction,
  updateLendingRulesAction,
  type SettingsActionResult,
} from '@/lib/settings/actions';
import type { FinanceSettings } from '@/lib/data/finance';
import type { LendingRules } from '@/lib/data/settings';

/**
 * The business's own lending rules — the guard rail, not a product.
 *
 * ## Why the screen insists on the distinction
 *
 * Since Phase 12 a loan's terms come from its **product**. These figures
 * bound what any product may offer: a product that tried to lend more than
 * the business maximum, or above twice the business rate, is refused when it
 * is saved. And since migration 20261012000500 the rail holds the other way
 * too — a change here that would strand an active product is refused, and
 * the refusal names the product. A person who does not know that reads a
 * refusal as a bug, so the form says it before they press the button.
 *
 * One figure is still global and only global: how many active loans a client
 * may hold. It is a fact about the borrower, not about a product, and a
 * per-product limit would let somebody hold one of each.
 */
export function LendingRulesForm({ rules }: { readonly rules: LendingRules }) {
  const [result, submit, pending] = useActionState<
    SettingsActionResult | undefined,
    FormData
  >(updateLendingRulesAction, undefined);

  const errors = result?.fieldErrors ?? {};
  const percent = (bps: number): string => String(bpsToPercent(toBps(bps)));

  return (
    <form action={submit} className="min-w-0 space-y-4">
      {result?.ok === true ? <Alert tone="success">{result.message}</Alert> : null}
      {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}

      <Alert tone="info" title="These bound the products; they are not a product">
        A loan takes its rate, duration and charges from its <strong>loan product</strong>
        . What you set here is the range every product has to stay inside — so a change
        that would leave a product offering more than the business permits is refused, and
        names the product.
      </Alert>

      <FormSection
        title="Amounts and duration"
        description="The outer limits of what the business will lend, whatever a product says."
      >
        <Field
          label="Smallest loan"
          name="minLoanAmount"
          required
          inputMode="numeric"
          defaultValue={String(rules.minLoanAmount)}
          error={errors.minLoanAmount?.[0]}
        />
        <Field
          label="Largest loan"
          name="maxLoanAmount"
          required
          inputMode="numeric"
          defaultValue={String(rules.maxLoanAmount)}
          error={errors.maxLoanAmount?.[0]}
        />
        <Field
          label="Multi-month threshold"
          name="multiMonthMinAmount"
          required
          inputMode="numeric"
          defaultValue={String(rules.multiMonthMinAmount)}
          error={errors.multiMonthMinAmount?.[0]}
          hint="A loan below this runs for one month."
        />
        <Field
          label="Active loans per client"
          name="maxActiveLoansPerClient"
          required
          inputMode="numeric"
          defaultValue={String(rules.maxActiveLoansPerClient)}
          error={errors.maxActiveLoansPerClient?.[0]}
          hint="Global, and deliberately not a product setting: a per-product limit would let one borrower hold one of each."
        />
        <Field
          label="Shortest term (months)"
          name="minLoanTermMonths"
          required
          inputMode="numeric"
          defaultValue={String(rules.minLoanTermMonths)}
          error={errors.minLoanTermMonths?.[0]}
        />
        <Field
          label="Longest term (months)"
          name="maxLoanTermMonths"
          required
          inputMode="numeric"
          defaultValue={String(rules.maxLoanTermMonths)}
          error={errors.maxLoanTermMonths?.[0]}
        />
      </FormSection>

      <FormSection
        title="Interest, lateness and guarantors"
        description="The standing rate, which also sets the ceiling a product may price up to."
      >
        <Field
          label="Standing monthly rate (%)"
          name="defaultMonthlyInterestRate"
          required
          inputMode="decimal"
          defaultValue={percent(rules.defaultMonthlyInterestRateBps)}
          error={errors.defaultMonthlyInterestRateBps?.[0]}
          hint="A product may price above this, up to twice it — no further."
        />
        <Field
          label="Grace period (days)"
          name="gracePeriodDays"
          required
          inputMode="numeric"
          defaultValue={String(rules.gracePeriodDays)}
          error={errors.gracePeriodDays?.[0]}
        />
        <Field
          label="Late-payment charge (%)"
          name="penaltyRate"
          required
          inputMode="decimal"
          defaultValue={percent(rules.penaltyRateBps)}
          error={errors.penaltyRateBps?.[0]}
        />
        <Field
          label="Guarantors required"
          name="minGuarantorsRequired"
          required
          inputMode="numeric"
          defaultValue={String(rules.minGuarantorsRequired)}
          error={errors.minGuarantorsRequired?.[0]}
          hint="The floor for every product. A product may ask for more."
        />
      </FormSection>

      <Button type="submit" loading={pending}>
        Save lending rules
      </Button>
    </form>
  );
}

/**
 * The finance thresholds.
 *
 * Read by the posting functions themselves, inside the transaction, which is
 * why no caller can opt out of them and why this screen is the only place
 * they are set.
 */
export function FinanceSettingsForm({
  settings,
}: {
  readonly settings: FinanceSettings;
}) {
  const [result, submit, pending] = useActionState<
    SettingsActionResult | undefined,
    FormData
  >(updateFinanceSettingsAction, undefined);

  const errors = result?.fieldErrors ?? {};

  return (
    <form action={submit} className="min-w-0 space-y-4">
      {result?.ok === true ? <Alert tone="success">{result.message}</Alert> : null}
      {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}

      <FormSection
        title="Second signature"
        description="Above these amounts, a movement waits for a second person. Below them it posts immediately."
      >
        <Field
          label="Transfers above"
          name="transferApprovalThreshold"
          required
          inputMode="numeric"
          defaultValue={String(settings.transferApprovalThreshold ?? 0)}
          error={errors.transferApprovalThreshold?.[0]}
          hint="Zero means every transfer needs approval."
        />
        <Field
          label="Expenses above"
          name="expenseApprovalThreshold"
          required
          inputMode="numeric"
          defaultValue={String(settings.expenseApprovalThreshold ?? 0)}
          error={errors.expenseApprovalThreshold?.[0]}
          hint="Zero means every expense needs approval."
        />

        <FullWidth>
          <label
            className="text-text flex items-start gap-2 text-sm"
            htmlFor="allowNegativeCash"
          >
            <input
              id="allowNegativeCash"
              type="checkbox"
              name="allowNegativeCash"
              defaultChecked={settings.allowNegativeCash}
              className="accent-accent mt-0.5 size-4 shrink-0"
            />
            <span>
              <span className="font-medium">Permit a cash account to go below zero</span>
              <span className="text-text-muted mt-1 block text-xs">
                Off, a payment or transfer that would overdraw a drawer is refused by the
                posting function itself. A drawer cannot really hold less than nothing, so
                leaving this off is what keeps the ledger describing the world.
              </span>
            </span>
          </label>
        </FullWidth>

        <FullWidth>
          <label
            className="text-text flex items-start gap-2 text-sm"
            htmlFor="reconciliationRequiresReview"
          >
            <input
              id="reconciliationRequiresReview"
              type="checkbox"
              name="reconciliationRequiresReview"
              defaultChecked={settings.reconciliationRequiresReview}
              className="accent-accent mt-0.5 size-4 shrink-0"
            />
            <span>
              <span className="font-medium">
                A daily count is reviewed before it stands
              </span>
              <span className="text-text-muted mt-1 block text-xs">
                A count is evidence, not an instruction: a difference is written off only
                by an explicit journal to Cash Over and Short, by somebody other than the
                person who counted.
              </span>
            </span>
          </label>
        </FullWidth>
      </FormSection>

      <FormSection
        title="Low-balance levels"
        description="The point at which a cash account is worth drawing attention to."
      >
        <Field
          label="Cash at hand below"
          name="lowBalanceCashAtHand"
          required
          inputMode="numeric"
          defaultValue={String(settings.lowBalanceCashAtHand)}
          error={errors.lowBalanceCashAtHand?.[0]}
        />
        <Field
          label="MTN Mobile Money below"
          name="lowBalanceMtn"
          required
          inputMode="numeric"
          defaultValue={String(settings.lowBalanceMtn)}
          error={errors.lowBalanceMtn?.[0]}
        />
        <Field
          label="Airtel Money below"
          name="lowBalanceAirtel"
          required
          inputMode="numeric"
          defaultValue={String(settings.lowBalanceAirtel)}
          error={errors.lowBalanceAirtel?.[0]}
        />
        <Field
          label="Cash at bank below"
          name="lowBalanceBank"
          required
          inputMode="numeric"
          defaultValue={String(settings.lowBalanceBank)}
          error={errors.lowBalanceBank?.[0]}
        />
      </FormSection>

      <Button type="submit" loading={pending}>
        Save finance settings
      </Button>
    </form>
  );
}
