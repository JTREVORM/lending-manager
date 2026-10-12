import { Landmark, Lock, PackageOpen, Settings } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { CompanyForm } from '@/components/settings/company-form';
import { DateValue, PhoneValue } from '@/components/ui/data-value';
import { FinanceSettingsForm, LendingRulesForm } from '@/components/settings/rules-forms';
import { Money } from '@/components/ui/money';
import { PageHeader, SectionHeader } from '@/components/ui/page-header';
import { SectionTabs } from '@/components/ui/section-tabs';
import { APP_NAME, APP_SHORT_NAME, APP_VERSION, ROUTES } from '@/config/app';
import { getAppEnvironment } from '@/lib/env.public';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getFinanceSettings } from '@/lib/data/finance';
import { getLoanProducts } from '@/lib/data/products';
import { getSettingsSnapshot } from '@/lib/data/settings';
import {
  PRODUCT_STATUS_LABELS,
  describeTerms,
  labelFor,
} from '@/lib/domain/loan-product';
import { REFERENCE_SCOPE_LABELS } from '@/lib/domain/reference';
import { formatBps, toBps } from '@/lib/domain/rate';

export const metadata = { title: 'Settings' };

/**
 * The business's configuration, by subject.
 *
 * ## What changed in Phase 12, and why
 *
 * This page used to be read-only, and said so: editing was a privileged write
 * with an audit trail and a set of cross-field rules, and Phase 9 was not for
 * building it. The consequence was a business whose own name, phone number
 * and interest rate could only be changed by a developer with a migration —
 * which is exactly what the brief for this phase refuses.
 *
 * So the sections an Owner may change are now forms, and every one of them
 * writes through the same database rules that have always been there: the
 * CHECK constraints, the audit triggers on both settings singletons, and —
 * new in this phase — the guard rail that refuses a change which would leave
 * an active loan product offering more than the business permits.
 *
 * ## The seven subjects
 *
 * Company, loan products, lending rules, guarantor rules, finance, branches
 * and references. Loan products have their own screen, because they are
 * read by roles that hold no `settings:view` at all and because four
 * products at twenty terms each is not a card on somebody else's page.
 *
 * ## What is still read-only, and honestly labelled
 *
 * Branches and reference numbering. Both are real configuration and both are
 * shown, but neither has an editing screen in this phase — and a control that
 * looked editable and was not would be worse than a page that says so.
 */
export default async function SettingsPage() {
  const context = await guardPermission(ROUTES.settings, 'settings:view');

  const [
    { company, rules, cadences, branches, sequences, unavailable },
    finance,
    products,
  ] = await Promise.all([
    getSettingsSnapshot(),
    getFinanceSettings(),
    // Products are gated by `products:view`, which every staff role holds,
    // so this is a summary with a link rather than the catalogue again.
    getLoanProducts(),
  ]);

  const canEdit = contextCan(context, 'settings:update');
  const canEditFinance = contextCan(context, 'finance:settings');
  const canSeeProducts = contextCan(context, 'products:view');

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Business Rules"
        icon={Settings}
        title="Settings"
        description="Who the business is, what it lends, and the limits every product has to stay inside."
        status={canEdit ? null : <Badge tone="neutral">Read-only</Badge>}
      />

      <Alert tone="info" title="Changing a setting does not change an existing loan">
        Every loan records its own product terms — rate, grace period and late-payment
        charge — at the moment it is approved, and those figures never move afterwards. A
        change made here applies to loans approved <strong>after</strong> the change,
        which is why a loan from last month can be on a different rate from one approved
        today.
      </Alert>

      {unavailable.length > 0 ? (
        <Alert tone="warning" title="Some settings could not be read">
          The values below may be incomplete. Tell your administrator if this persists.
        </Alert>
      ) : null}

      <SectionTabs
        label="Settings sections"
        tabs={[
          { id: 'company-heading', label: 'Company' },
          { id: 'products-heading', label: 'Products' },
          { id: 'rules-heading', label: 'Lending' },
          { id: 'guarantors-heading', label: 'Guarantors' },
          { id: 'finance-heading', label: 'Finance' },
          { id: 'branches-heading', label: 'Branches' },
          { id: 'references-heading', label: 'References' },
        ]}
      />

      {/* --- 1. Company -------------------------------------------------- */}
      <section aria-labelledby="company-heading">
        <SectionHeader
          id="company-heading"
          title="Company"
          description="Who the business is. Appears on the sign-in screen, in the header, and on every receipt and statement."
        />

        {company === null ? (
          <Card>
            <p className="text-text-muted text-sm">
              The company record could not be read.
            </p>
          </Card>
        ) : canEdit ? (
          <CompanyForm company={company} />
        ) : (
          <Card>
            <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
              <Setting label="Trading name" value={company.companyName} />
              <Setting label="Registered name" value={company.legalName} />
              <Setting label="Tagline" value={company.tagline} />
              <Setting
                label="Registration number"
                value={company.registrationNumber}
                sensitive
              />
              <Setting
                label="Tax identification number"
                value={company.taxIdentificationNumber}
                sensitive
              />
              <Setting
                label="Phone"
                value={
                  company.phone === null ? null : <PhoneValue value={company.phone} />
                }
              />
              <Setting
                label="Second phone"
                value={
                  company.phoneSecondary === null ? null : (
                    <PhoneValue value={company.phoneSecondary} />
                  )
                }
              />
              <Setting label="Email" value={company.email} />
              <Setting label="Postal address" value={company.postalAddress} />
              <Setting
                label="Office"
                value={
                  [
                    company.addressLine1,
                    company.addressLine2,
                    company.city,
                    company.country,
                  ]
                    .filter((part) => part !== null && part !== '')
                    .join(', ') || null
                }
              />
              <Setting label="Receipt heading" value={company.receiptHeader} />
              <Setting label="Receipt footer" value={company.receiptFooter} />
              <Setting label="Currency" value={company.currencyCode} />
              <Setting label="Locale" value={company.locale} />
              <Setting
                label="Business timezone"
                value={company.timezone}
                hint="Decides which calendar day a payment lands on, and when a collection becomes overdue."
              />
            </dl>

            <p className="text-text-muted mt-4 text-sm">
              Today, in the business timezone, is{' '}
              <DateValue value={new Date()} timeZone={company.timezone} />.
            </p>
          </Card>
        )}
      </section>

      {/* --- 2. Loan products -------------------------------------------- */}
      <section aria-labelledby="products-heading">
        <SectionHeader
          id="products-heading"
          title="Loan products"
          description="What the business sells. A loan takes its terms from its product, inside the limits below."
          action={
            canSeeProducts ? (
              <Link
                href={ROUTES.loanProducts}
                className="text-accent text-sm font-semibold hover:underline"
              >
                Open loan products
              </Link>
            ) : null
          }
        />

        <Card>
          {!canSeeProducts ? (
            <p className="text-text-muted text-sm">
              Your role does not include reading the product catalogue.
            </p>
          ) : products.length === 0 ? (
            <p className="text-text-muted text-sm">No products could be read.</p>
          ) : (
            <ul className="divide-border min-w-0 divide-y">
              {products.map((product) => (
                <li
                  key={product.productId}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <PackageOpen
                      aria-hidden="true"
                      className="text-text-muted size-4 shrink-0"
                    />
                    <span className="text-text font-medium">{product.name}</span>
                    <span className="text-text-muted font-mono text-xs">
                      {product.productCode}
                    </span>
                    {product.isDefault ? <Badge tone="info">Default</Badge> : null}
                    {product.status === 'active' ? null : (
                      <Badge tone="neutral">
                        {labelFor(PRODUCT_STATUS_LABELS, product.status)}
                      </Badge>
                    )}
                  </span>
                  <span className="text-text-muted flex flex-wrap items-center gap-3 text-sm">
                    <span>
                      <Money amount={product.minAmount} />–
                      <Money amount={product.maxAmount} />
                    </span>
                    <span>{formatBps(toBps(product.defaultInterestRateBps))}</span>
                    <span>{describeTerms(product)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {/* --- 3. Lending rules -------------------------------------------- */}
      <section aria-labelledby="rules-heading">
        <SectionHeader
          id="rules-heading"
          title="Lending rules"
          description="The limits every product has to stay inside, and the one rule that is global."
        />

        {rules === null ? (
          <Card>
            <p className="text-text-muted text-sm">
              The lending rules could not be read.
            </p>
          </Card>
        ) : canEdit ? (
          <LendingRulesForm rules={rules} />
        ) : (
          <div className="grid min-w-0 gap-4 md:grid-cols-2">
            <Card>
              <CardHeader title="Amounts and term" as="h3" />
              <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
                <Setting
                  label="Smallest loan"
                  value={<Money amount={rules.minLoanAmount} />}
                />
                <Setting
                  label="Largest loan"
                  value={<Money amount={rules.maxLoanAmount} />}
                />
                <Setting
                  label="Multi-month threshold"
                  value={<Money amount={rules.multiMonthMinAmount} />}
                  hint="A loan below this runs for one month."
                />
                <Setting
                  label="Term"
                  value={`${String(rules.minLoanTermMonths)} to ${String(rules.maxLoanTermMonths)} months`}
                />
                <Setting
                  label="Active loans per client"
                  value={String(rules.maxActiveLoansPerClient)}
                  hint="Global, and deliberately not a product setting."
                />
              </dl>
            </Card>

            <Card>
              <CardHeader title="Interest and late payment" as="h3" />
              <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
                <Setting
                  label="Standing monthly rate"
                  value={formatBps(toBps(rules.defaultMonthlyInterestRateBps))}
                  hint="A product may price up to twice this, no further."
                />
                <Setting
                  label="Grace period"
                  value={`${String(rules.gracePeriodDays)} days`}
                />
                <Setting
                  label="Late-payment charge"
                  value={formatBps(toBps(rules.penaltyRateBps))}
                />
              </dl>
            </Card>
          </div>
        )}
      </section>

      {/* --- 4. Guarantor rules ------------------------------------------ */}
      <section aria-labelledby="guarantors-heading">
        <SectionHeader
          id="guarantors-heading"
          title="Guarantor rules"
          description="What the business asks for before it lends, and where each part of it is decided."
        />

        <Card>
          <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
            <Setting
              label="Guarantors required"
              value={rules === null ? null : String(rules.minGuarantorsRequired)}
              hint="The floor for every product. Set with the lending rules above; a product may ask for more."
            />
            <Setting
              label="Per product"
              value={
                products.length === 0
                  ? null
                  : products
                      .filter((product) => product.guarantorRequired)
                      .map(
                        (product) => `${product.name}: ${String(product.minGuarantors)}`,
                      )
                      .join(' · ') || 'No product requires one'
              }
              hint="Set on the product, because a Business Loan and a Quick Loan do not ask for the same security."
            />
            <Setting
              label="Collateral"
              value={
                products.length === 0
                  ? null
                  : products
                      .filter((product) => product.collateralRequired)
                      .map((product) => product.name)
                      .join(' · ') || 'No product requires it'
              }
            />
            <Setting
              label="Completeness"
              value="Name, phone, location and identification"
              hint="A loan cannot be approved while an attached guarantor is missing any of these — enforced by the approval validator, not by this screen."
            />
          </dl>
        </Card>
      </section>

      {/* --- 5. Finance --------------------------------------------------- */}
      <section aria-labelledby="finance-heading">
        <SectionHeader
          id="finance-heading"
          title="Finance"
          description="When a movement needs a second signature, and when a cash account is worth drawing attention to."
          action={
            <Link
              href={ROUTES.finance}
              className="text-accent text-sm font-semibold hover:underline"
            >
              Open finance
            </Link>
          }
        />

        {finance === null ? (
          <Card>
            <p className="text-text-muted text-sm">
              The finance settings could not be read.
            </p>
          </Card>
        ) : canEditFinance ? (
          <FinanceSettingsForm settings={finance} />
        ) : (
          <Card>
            <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
              <Setting
                label="Transfers above"
                value={
                  finance.transferApprovalThreshold === null ? (
                    'Every transfer'
                  ) : (
                    <Money amount={finance.transferApprovalThreshold} />
                  )
                }
                hint="Need a second person before they post."
              />
              <Setting
                label="Expenses above"
                value={
                  finance.expenseApprovalThreshold === null ? (
                    'Every expense'
                  ) : (
                    <Money amount={finance.expenseApprovalThreshold} />
                  )
                }
              />
              <Setting
                label="Overdrawing a cash account"
                value={finance.allowNegativeCash ? 'Permitted' : 'Refused'}
                hint="A drawer cannot hold less than nothing, so the posting functions refuse it."
              />
              <Setting
                label="A daily count"
                value={
                  finance.reconciliationRequiresReview
                    ? 'Reviewed before it stands'
                    : 'Stands as submitted'
                }
              />
              <Setting
                label="Low cash at hand"
                value={<Money amount={finance.lowBalanceCashAtHand} />}
              />
              <Setting
                label="Low MTN balance"
                value={<Money amount={finance.lowBalanceMtn} />}
              />
              <Setting
                label="Low Airtel balance"
                value={<Money amount={finance.lowBalanceAirtel} />}
              />
              <Setting
                label="Low bank balance"
                value={<Money amount={finance.lowBalanceBank} />}
              />
            </dl>
          </Card>
        )}
      </section>

      {/* --- 6. Branches -------------------------------------------------- */}
      <section aria-labelledby="branches-heading">
        <SectionHeader
          id="branches-heading"
          title="Branches"
          description="Where the business operates. Each branch has its own cash accounts in the ledger."
        />

        <Card>
          {branches.length === 0 ? (
            <p className="text-text-muted text-sm">
              No branches could be read. This needs the branches:view capability.
            </p>
          ) : (
            <ul className="divide-border min-w-0 divide-y">
              {branches.map((branch) => (
                <li
                  key={branch.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Landmark
                      aria-hidden="true"
                      className="text-text-muted size-4 shrink-0"
                    />
                    <span className="text-text font-medium">{branch.name}</span>
                    <span className="text-text-muted font-mono text-xs">
                      {branch.branchCode}
                    </span>
                    {branch.status === 'active' ? null : (
                      <Badge tone="neutral">{branch.status}</Badge>
                    )}
                  </span>
                  <span className="text-text-muted flex flex-wrap items-center gap-3 text-sm">
                    {[branch.location, branch.district]
                      .filter((part) => part !== null && part !== '')
                      .join(', ')}
                    {branch.openedOn === null ? null : (
                      <span>
                        opened <DateValue value={branch.openedOn} />
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <p className="text-text-muted mt-4 text-sm">
            Adding or renaming a branch is not editable from this screen. A branch owns
            cash accounts in the ledger and appears on every loan and payment written at
            it, so creating one is a privileged write with its own capability
            (branches:create) rather than a field on a settings page.
          </p>
        </Card>
      </section>

      {/* --- 7. References ------------------------------------------------ */}
      <section aria-labelledby="references-heading">
        <SectionHeader
          id="references-heading"
          title="References and repayment cadences"
          description="How the system numbers things, and how often a borrower may pay."
        />

        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          <Card>
            <CardHeader title="Repayment cadences" as="h3" />
            {cadences.length === 0 ? (
              <p className="text-text-muted text-sm">No cadences could be read.</p>
            ) : (
              <ul className="divide-border min-w-0 divide-y">
                {cadences.map((cadence) => (
                  <li
                    key={cadence.key}
                    className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
                  >
                    <span className="text-text font-medium">{cadence.label}</span>
                    <span className="text-text-muted flex items-center gap-3 text-sm">
                      <span>
                        every {cadence.intervalDays}{' '}
                        {cadence.intervalDays === 1 ? 'day' : 'days'}
                      </span>
                      {cadence.isActive ? null : (
                        <Badge tone="neutral">Not offered</Badge>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-text-muted mt-4 text-sm">
              A loan records its own cadence at approval, and a product names which
              cadences it offers. Retiring a cadence here stops new loans using it and
              leaves every existing schedule exactly as it was.
            </p>
          </Card>

          <Card>
            <CardHeader title="Reference numbering" as="h3" />
            {sequences.length === 0 ? (
              <p className="text-text-muted text-sm">No sequences could be read.</p>
            ) : (
              <ul className="divide-border min-w-0 divide-y">
                {sequences.map((sequence) => (
                  <li
                    key={`${sequence.scope}-${String(sequence.periodYear)}`}
                    className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
                  >
                    <span className="text-text font-medium">
                      {labelFor(REFERENCE_SCOPE_LABELS, sequence.scope)}
                    </span>
                    <span className="text-text-muted text-sm">
                      20{String(sequence.periodYear).padStart(2, '0')} ·{' '}
                      {sequence.lastValue} issued
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-text-muted mt-4 text-sm">
              Each reference is allocated by the database, once, inside the transaction
              that creates the record — so two clients cannot be given the same number and
              a number is never reused. The counters restart each year, which is what
              makes CL26001 readable.
            </p>
          </Card>
        </div>
      </section>

      {/* --- Who may change what ----------------------------------------- */}
      <section aria-labelledby="editing-heading">
        <SectionHeader id="editing-heading" title="Who may change these" />
        <Card>
          <div className="flex items-start gap-3">
            <span className="bg-surface-raised flex size-9 shrink-0 items-center justify-center rounded-lg">
              <Lock aria-hidden="true" className="text-text-muted size-4" />
            </span>
            <div className="min-w-0 text-sm">
              <p className="text-text">
                {canEdit
                  ? 'Your role may change the company details and the lending rules.'
                  : 'Only the Owner / Administrator may change the company details and the lending rules.'}
                {canEditFinance
                  ? ' The finance thresholds are yours as well.'
                  : ' The finance thresholds need the finance:settings capability.'}
              </p>
              <p className="text-text-muted mt-1">
                Every change is recorded in the audit trail with the values before and
                after it, by a trigger on the table rather than by this screen. The
                database enforces the cross-field rules whatever asks it — including the
                one that refuses a change here which would leave an active loan product
                offering more than the business permits.
              </p>
            </div>
          </div>
        </Card>
      </section>

      {/* --- This build --------------------------------------------------- */}
      {/* §108. Somewhere a person can read which version they are looking at.
          Without it, "it is still not showing my change" is an argument
          rather than a question — and on an installed progressive web app,
          where a stale service worker can serve yesterday's shell, it is the
          first thing worth checking. */}
      <section aria-labelledby="build-heading">
        <SectionHeader
          id="build-heading"
          title="This build"
          description="Quote this if something looks out of date."
        />
        <Card>
          <dl className="grid min-w-0 gap-4 sm:grid-cols-3">
            <Setting label="Application" value={APP_NAME} />
            <Setting
              label="Version"
              value={<span className="font-mono">{APP_VERSION}</span>}
            />
            <Setting label="Environment" value={getAppEnvironment()} />
          </dl>
        </Card>
      </section>

      <p className="text-text-muted text-xs">
        {APP_NAME} ({APP_SHORT_NAME}).
      </p>
    </div>
  );
}

/**
 * One setting.
 *
 * `sensitive` marks a value that is the business's own registration detail
 * rather than an operational number. It is still shown — the capability to
 * open this page is `settings:view`, which only staff hold — but it is marked,
 * so nobody reads a tax number off a screen that is being projected without
 * noticing what is on it.
 */
function Setting({
  label,
  value,
  hint,
  sensitive = false,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: string;
  readonly sensitive?: boolean;
}) {
  const empty = value === null || value === undefined || value === '';

  return (
    <div className="min-w-0">
      <dt className="text-text-muted flex items-center gap-1.5 text-xs">
        {label}
        {sensitive ? (
          <Lock aria-label="Business registration detail" className="size-3" />
        ) : null}
      </dt>
      <dd className="text-text mt-0.5 font-medium break-words">
        {empty ? (
          <span className="text-text-muted font-normal">Not recorded</span>
        ) : (
          value
        )}

        {/* The hint lives inside the `<dd>`, not beside it.

            A `<div>` is a permitted child of `<dl>`, but only as a wrapper
            around `<dt>`/`<dd>` groups — anything else inside it is invalid,
            which an axe sweep reported as "dl element has direct children
            that are not allowed: div > p". It is also the better reading
            order: the hint explains the value, so it belongs with it. */}
        {hint === undefined ? null : (
          <span className="text-text-muted mt-0.5 block text-xs font-normal">{hint}</span>
        )}
      </dd>
    </div>
  );
}
