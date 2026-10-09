'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CompanyLogo } from '@/components/brand/company-logo';
import { Field } from '@/components/ui/field';
import { FormSection, FullWidth } from '@/components/clients/form-section';
import {
  updateCompanyIdentityAction,
  type SettingsActionResult,
} from '@/lib/settings/actions';
import type { CompanyProfile } from '@/lib/data/settings';

/**
 * The company's own identity.
 *
 * ## Why this is a form and not a migration
 *
 * Phase 12 replaced a placeholder with the real business — Polytos Financial
 * Services Ltd — and did it in a migration, because the row had to change in
 * every environment at once. What must not follow from that is a business
 * whose own name, phone number and address can only be changed by a
 * developer. Everything here reads from `company_settings` at runtime: the
 * sign-in screen, the sidebar, every receipt, every statement. This is where
 * it is set.
 *
 * ## What is deliberately not editable here
 *
 * The currency. One row, one code, and every amount in the database is whole
 * Ugandan shillings — a business that changed it would be a business whose
 * historical figures silently changed meaning. Changing currency is a
 * migration with a conversion, not a settings field.
 */
export function CompanyForm({ company }: { readonly company: CompanyProfile }) {
  const [result, submit, pending] = useActionState<
    SettingsActionResult | undefined,
    FormData
  >(updateCompanyIdentityAction, undefined);

  const errors = result?.fieldErrors ?? {};

  return (
    <form action={submit} className="min-w-0 space-y-4">
      {result?.ok === true ? <Alert tone="success">{result.message}</Alert> : null}
      {result?.ok === false ? <Alert tone="danger">{result.message}</Alert> : null}

      <FormSection
        title="Who the business is"
        description="The trading name appears on the sign-in screen, in the header and on every document."
      >
        <Field
          label="Trading name"
          name="companyName"
          required
          defaultValue={company.companyName}
          error={errors.companyName?.[0]}
        />
        <Field
          label="Registered name"
          name="legalName"
          defaultValue={company.legalName ?? ''}
          error={errors.legalName?.[0]}
          hint="As registered, if it differs from the trading name."
        />
        <FullWidth>
          <Field
            label="Tagline"
            name="tagline"
            defaultValue={company.tagline ?? ''}
            error={errors.tagline?.[0]}
            hint="The line under the name on a document and on the sign-in screen."
          />
        </FullWidth>
        <Field
          label="Registration number"
          name="registrationNumber"
          defaultValue={company.registrationNumber ?? ''}
          error={errors.registrationNumber?.[0]}
          hint="Not printed on a borrower's receipt."
        />
        <Field
          label="Tax identification number"
          name="taxIdentificationNumber"
          defaultValue={company.taxIdentificationNumber ?? ''}
          error={errors.taxIdentificationNumber?.[0]}
          hint="Not printed on a borrower's receipt."
        />
      </FormSection>

      <FormSection
        title="How to reach the business"
        description="Both numbers and both addresses are printed on receipts and statements."
      >
        <Field
          label="Phone"
          name="phone"
          defaultValue={company.phone ?? ''}
          error={errors.phone?.[0]}
          hint="Any form staff would type. Stored as +256…"
        />
        <Field
          label="Second phone"
          name="phoneSecondary"
          defaultValue={company.phoneSecondary ?? ''}
          error={errors.phoneSecondary?.[0]}
        />
        <Field
          label="Email"
          name="email"
          type="email"
          defaultValue={company.email ?? ''}
          error={errors.email?.[0]}
        />
        <Field
          label="Postal address"
          name="postalAddress"
          defaultValue={company.postalAddress ?? ''}
          error={errors.postalAddress?.[0]}
          hint="The P.O. Box a letter goes to."
        />
        <Field
          label="Address line 1"
          name="addressLine1"
          defaultValue={company.addressLine1 ?? ''}
          error={errors.addressLine1?.[0]}
          hint="Where the office actually is."
        />
        <Field
          label="Address line 2"
          name="addressLine2"
          defaultValue={company.addressLine2 ?? ''}
          error={errors.addressLine2?.[0]}
        />
        <Field
          label="City or town"
          name="city"
          defaultValue={company.city ?? ''}
          error={errors.city?.[0]}
        />
        <Field
          label="Country"
          name="country"
          defaultValue={company.country ?? ''}
          error={errors.country?.[0]}
        />
      </FormSection>

      <FormSection
        title="Branding"
        description="The mark and the colour the application and its documents carry."
      >
        <FullWidth>
          <div className="flex min-w-0 items-center gap-4">
            <CompanyLogo
              companyName={company.companyName}
              logoPath={company.logoPath}
              size="hero"
              className="border-border border"
            />
            <p className="text-text-muted min-w-0 text-sm">
              The current mark, as the sign-in screen, the sidebar and every document show
              it. It is a file that ships with the application; the path below names which
              one.
            </p>
          </div>
        </FullWidth>

        <Field
          label="Logo path"
          name="logoPath"
          defaultValue={company.logoPath ?? ''}
          error={errors.logoPath?.[0]}
          hint="A path under the application's public assets, for example brand/polytos-logo.webp."
        />
        <Field
          label="Brand colour"
          name="brandPrimaryColor"
          defaultValue={company.brandPrimaryColor ?? ''}
          error={errors.brandPrimaryColor?.[0]}
          hint="Six hex digits after a hash, for example #0B4394."
        />
      </FormSection>

      <FormSection
        title="Documents"
        description="What a receipt says above and below the figures."
      >
        <FullWidth>
          <Field
            label="Receipt heading"
            name="receiptHeader"
            defaultValue={company.receiptHeader ?? ''}
            error={errors.receiptHeader?.[0]}
          />
        </FullWidth>
        <FullWidth>
          <Field
            label="Receipt footer"
            name="receiptFooter"
            defaultValue={company.receiptFooter ?? ''}
            error={errors.receiptFooter?.[0]}
            hint="For example: Thank you for your business. Keep this receipt as proof of payment."
          />
        </FullWidth>
      </FormSection>

      <FormSection
        title="Currency, locale and the business day"
        description="How figures and dates are written, and what the system means by “today”."
      >
        <Field
          label="Currency"
          name="currencyCodeDisplay"
          defaultValue={company.currencyCode}
          disabled
          hint="Fixed. Every amount recorded is whole Ugandan shillings; changing the code would change what the history means."
        />
        <Field
          label="Locale"
          name="locale"
          required
          defaultValue={company.locale}
          error={errors.locale?.[0]}
          hint="For example en-UG."
        />
        <Field
          label="Business timezone"
          name="timezone"
          required
          defaultValue={company.timezone}
          error={errors.timezone?.[0]}
          hint="Decides which calendar day a payment lands on, and when a collection becomes overdue."
        />
      </FormSection>

      <Button type="submit" loading={pending}>
        Save company details
      </Button>
    </form>
  );
}
