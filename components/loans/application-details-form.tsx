'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { FormSection, FullWidth } from '@/components/clients/form-section';
import { SelectField } from '@/components/clients/select-field';
import {
  saveBusinessDetailsAction,
  saveSalaryDetailsAction,
} from '@/lib/loans/application-actions';
import {
  EMPLOYMENT_STATUSES,
  EMPLOYMENT_STATUS_LABELS,
  PREMISES_OWNERSHIP,
  PREMISES_OWNERSHIP_LABELS,
  SALARY_VERIFICATIONS,
  SALARY_VERIFICATION_LABELS,
} from '@/lib/validation/loan-application';
import type { LoanApplicationProfile } from '@/lib/data/loan-application';
import type { ActionResult } from '@/lib/auth/actions';

/**
 * The questions a product asks, as a form.
 *
 * Two forms rather than one with a `profile` prop, because they share almost
 * nothing: a salary application asks who employs the borrower and when they
 * are paid; a business application asks what the business turns over and what
 * the money is for. A single component holding both would be a component
 * where half the fields are always hidden.
 *
 * Both are editable only while the loan is a draft. The control is not
 * rendered otherwise — `loan_application_details_guard` would refuse the write
 * anyway, and a form that submits into a refusal is a form that wastes
 * somebody's typing.
 */

export function SalaryDetailsForm({
  loanId,
  profile,
  editable,
}: {
  readonly loanId: string;
  readonly profile: LoanApplicationProfile;
  readonly editable: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    saveSalaryDetailsAction,
    undefined,
  );

  const salary = profile.salary;

  if (!editable) {
    return <SalaryDetailsSummary profile={profile} />;
  }

  const fieldError = (name: string): string | undefined =>
    state?.fieldErrors?.[name]?.[0];

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="loanId" value={loanId} />

      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      <FormSection
        title="Employment"
        description="What a salary loan is assessed on. The approval refuses an application that cannot say who employs the borrower."
      >
        <Field
          label="Employer name"
          name="employerName"
          required
          defaultValue={salary?.employerName ?? ''}
          error={fieldError('employerName')}
        />
        <Field
          label="Employer contact"
          name="employerContact"
          defaultValue={salary?.employerContact ?? ''}
          hint="A phone number or an office, for verification."
          error={fieldError('employerContact')}
        />
        <Field
          label="Job title"
          name="jobTitle"
          required
          defaultValue={salary?.jobTitle ?? ''}
          error={fieldError('jobTitle')}
        />
        <Field
          label="Staff or employee number"
          name="staffNumber"
          defaultValue={salary?.staffNumber ?? ''}
          error={fieldError('staffNumber')}
        />
        <SelectField
          label="Employment status"
          name="employmentStatus"
          defaultValue={salary?.employmentStatus ?? ''}
          options={[
            { value: '', label: 'Not stated' },
            ...EMPLOYMENT_STATUSES.map((status) => ({
              value: status,
              label: EMPLOYMENT_STATUS_LABELS[status],
            })),
          ]}
          error={fieldError('employmentStatus')}
        />
        <Field
          label="Employed since"
          name="employmentStartedOn"
          type="date"
          defaultValue={salary?.employmentStartedOn ?? ''}
          hint="How long they have held the job."
          error={fieldError('employmentStartedOn')}
        />
      </FormSection>

      <FormSection title="Salary">
        <Field
          label="Net monthly salary"
          name="netMonthlySalary"
          inputMode="numeric"
          required
          defaultValue={salary === null ? '' : String(salary.netMonthlySalary)}
          hint="Whole shillings, after deductions."
          error={fieldError('netMonthlySalary')}
        />
        <Field
          label="Salary payment day"
          name="salaryPayDay"
          inputMode="numeric"
          required
          defaultValue={salary === null ? '' : String(salary.salaryPayDay)}
          hint="The day of the month the money lands. The collection plan should not fall before it."
          error={fieldError('salaryPayDay')}
        />
        <SelectField
          label="Salary verification"
          name="salaryVerification"
          defaultValue={salary?.salaryVerification ?? 'not_checked'}
          options={SALARY_VERIFICATIONS.map((value) => ({
            value,
            label: SALARY_VERIFICATION_LABELS[value],
          }))}
          hint="Whether the stated salary was checked, and how."
          error={fieldError('salaryVerification')}
        />
      </FormSection>

      <div className="flex flex-col gap-3 sm:flex-row-reverse">
        <Button type="submit" disabled={pending} className="sm:w-auto">
          {pending ? 'Saving…' : 'Save employment details'}
        </Button>
      </div>
    </form>
  );
}

export function BusinessDetailsForm({
  loanId,
  profile,
  editable,
}: {
  readonly loanId: string;
  readonly profile: LoanApplicationProfile;
  readonly editable: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    saveBusinessDetailsAction,
    undefined,
  );

  const business = profile.business;

  if (!editable) {
    return <BusinessDetailsSummary profile={profile} />;
  }

  const fieldError = (name: string): string | undefined =>
    state?.fieldErrors?.[name]?.[0];

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="loanId" value={loanId} />

      {state?.message !== undefined ? (
        <Alert tone={state.ok ? 'success' : 'danger'}>{state.message}</Alert>
      ) : null}

      <FormSection
        title="The business"
        description="What a business loan is assessed on."
      >
        <Field
          label="Business name"
          name="businessName"
          required
          defaultValue={business?.businessName ?? ''}
          error={fieldError('businessName')}
        />
        <Field
          label="Business type"
          name="businessType"
          required
          defaultValue={business?.businessType ?? ''}
          hint="Retail, produce, transport, tailoring and so on."
          error={fieldError('businessType')}
        />
        <Field
          label="Business location"
          name="businessLocation"
          required
          defaultValue={business?.businessLocation ?? ''}
          error={fieldError('businessLocation')}
        />
        <Field
          label="Business contact"
          name="businessContact"
          defaultValue={business?.businessContact ?? ''}
          error={fieldError('businessContact')}
        />
        <Field
          label="Trading since"
          name="tradingSince"
          type="date"
          defaultValue={business?.tradingSince ?? ''}
          hint="How long the business has been running."
          error={fieldError('tradingSince')}
        />
        <Field
          label="Trading licence number"
          name="tradingLicenceNumber"
          defaultValue={business?.tradingLicenceNumber ?? ''}
          hint="Where the business is registered."
          error={fieldError('tradingLicenceNumber')}
        />
        <SelectField
          label="Premises"
          name="premisesOwnership"
          defaultValue={business?.premisesOwnership ?? ''}
          options={[
            { value: '', label: 'Not stated' },
            ...PREMISES_OWNERSHIP.map((value) => ({
              value,
              label: PREMISES_OWNERSHIP_LABELS[value],
            })),
          ]}
          error={fieldError('premisesOwnership')}
        />
        <Field
          label="People employed"
          name="employeeCount"
          inputMode="numeric"
          defaultValue={
            business?.employeeCount === null ? '' : String(business?.employeeCount ?? '')
          }
          error={fieldError('employeeCount')}
        />
      </FormSection>

      <FormSection
        title="Money in and out"
        description="An income with no costs beside it is not an assessment."
      >
        <Field
          label="Monthly turnover"
          name="monthlyTurnover"
          inputMode="numeric"
          required
          defaultValue={business === null ? '' : String(business.monthlyTurnover)}
          hint="Whole shillings, as an estimate."
          error={fieldError('monthlyTurnover')}
        />
        <Field
          label="Monthly expenses"
          name="monthlyExpenses"
          inputMode="numeric"
          defaultValue={
            business?.monthlyExpenses === null || business?.monthlyExpenses === undefined
              ? ''
              : String(business.monthlyExpenses)
          }
          hint="Optional. Leave blank rather than invent a figure."
          error={fieldError('monthlyExpenses')}
        />
        <FullWidth>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="loan-purpose" required>
              Purpose of the loan
            </Label>
            <textarea
              id="loan-purpose"
              name="loanPurpose"
              rows={3}
              maxLength={500}
              required
              defaultValue={business?.loanPurpose ?? ''}
              aria-invalid={fieldError('loanPurpose') !== undefined}
              className="border-border bg-surface text-text focus-visible:outline-accent aria-invalid:border-danger w-full rounded-lg border p-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2"
            />
            <p className="text-text-muted text-sm">
              What the money is for. The single most useful line on a business
              application.
            </p>
            {fieldError('loanPurpose') !== undefined ? (
              <p role="alert" className="text-danger text-sm">
                {fieldError('loanPurpose')}
              </p>
            ) : null}
          </div>
        </FullWidth>
      </FormSection>

      <div className="flex flex-col gap-3 sm:flex-row-reverse">
        <Button type="submit" disabled={pending} className="sm:w-auto">
          {pending ? 'Saving…' : 'Save business details'}
        </Button>
      </div>
    </form>
  );
}

/** The salary answers, read-only, once the application has been submitted. */
export function SalaryDetailsSummary({
  profile,
}: {
  readonly profile: LoanApplicationProfile;
}) {
  const salary = profile.salary;

  if (salary === null) {
    return (
      <Alert tone="warning">
        {profile.productName} is a salary product and the employment details have not been
        entered. An approval will be refused until they are.
      </Alert>
    );
  }

  return (
    <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
      <Detail label="Employer">{salary.employerName}</Detail>
      <Detail label="Employer contact">{salary.employerContact ?? '—'}</Detail>
      <Detail label="Job title">{salary.jobTitle}</Detail>
      <Detail label="Staff number">{salary.staffNumber ?? '—'}</Detail>
      <Detail label="Employment status">
        {salary.employmentStatus === null
          ? '—'
          : (EMPLOYMENT_STATUS_LABELS[
              salary.employmentStatus as keyof typeof EMPLOYMENT_STATUS_LABELS
            ] ?? salary.employmentStatus)}
      </Detail>
      <Detail label="Employed since">{salary.employmentStartedOn ?? '—'}</Detail>
      <Detail label="Net monthly salary">
        <span className="tabular-nums">
          UGX {salary.netMonthlySalary.toLocaleString('en-UG')}
        </span>
      </Detail>
      <Detail label="Paid on">Day {String(salary.salaryPayDay)} of the month</Detail>
      <Detail label="Verification">
        {SALARY_VERIFICATION_LABELS[
          salary.salaryVerification as keyof typeof SALARY_VERIFICATION_LABELS
        ] ?? salary.salaryVerification}
      </Detail>
      <Detail label="Evidence on file">
        {[
          salary.hasPayslip ? 'Payslip' : null,
          salary.hasEmploymentLetter ? 'Employment letter' : null,
        ]
          .filter((value) => value !== null)
          .join(', ') || 'None'}
      </Detail>
    </dl>
  );
}

/** The business answers, read-only, once the application has been submitted. */
export function BusinessDetailsSummary({
  profile,
}: {
  readonly profile: LoanApplicationProfile;
}) {
  const business = profile.business;

  if (business === null) {
    return (
      <Alert tone="warning">
        {profile.productName} is a business product and the business details have not been
        entered. An approval will be refused until they are.
      </Alert>
    );
  }

  return (
    <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
      <Detail label="Business">{business.businessName}</Detail>
      <Detail label="Type">{business.businessType}</Detail>
      <Detail label="Location">{business.businessLocation}</Detail>
      <Detail label="Contact">{business.businessContact ?? '—'}</Detail>
      <Detail label="Trading since">{business.tradingSince ?? '—'}</Detail>
      <Detail label="Licence number">{business.tradingLicenceNumber ?? '—'}</Detail>
      <Detail label="Premises">
        {business.premisesOwnership === null
          ? '—'
          : (PREMISES_OWNERSHIP_LABELS[
              business.premisesOwnership as keyof typeof PREMISES_OWNERSHIP_LABELS
            ] ?? business.premisesOwnership)}
      </Detail>
      <Detail label="People employed">
        {business.employeeCount === null ? '—' : String(business.employeeCount)}
      </Detail>
      <Detail label="Monthly turnover">
        <span className="tabular-nums">
          UGX {business.monthlyTurnover.toLocaleString('en-UG')}
        </span>
      </Detail>
      <Detail label="Monthly expenses">
        {business.monthlyExpenses === null ? (
          '—'
        ) : (
          <span className="tabular-nums">
            UGX {business.monthlyExpenses.toLocaleString('en-UG')}
          </span>
        )}
      </Detail>
      <div className="min-w-0 sm:col-span-2">
        <dt className="text-text-muted text-sm">Purpose</dt>
        <dd className="text-text mt-0.5 break-words whitespace-pre-wrap">
          {business.loanPurpose}
        </dd>
      </div>
      <Detail label="Evidence on file">
        {[
          business.hasTradingLicence ? 'Trading licence' : null,
          business.hasBankStatement ? 'Bank statement' : null,
        ]
          .filter((value) => value !== null)
          .join(', ') || 'None'}
      </Detail>
    </dl>
  );
}

function Detail({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted text-sm">{label}</dt>
      <dd className="text-text mt-0.5 break-words">{children}</dd>
    </div>
  );
}
