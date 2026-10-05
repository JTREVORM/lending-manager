import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { DateValue, PhoneValue } from '@/components/ui/data-value';
import { Money } from '@/components/ui/money';
import { PageHeader, SectionHeader } from '@/components/ui/page-header';
import { SectionTabs } from '@/components/ui/section-tabs';
import { APP_NAME, APP_SHORT_NAME, APP_VERSION, ROUTES } from '@/config/app';
import { getAppEnvironment } from '@/lib/env.public';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getSettingsSnapshot } from '@/lib/data/settings';
import { formatBps, toBps } from '@/lib/domain/rate';

export const metadata = { title: 'Settings' };

/**
 * The business's current configuration.
 *
 * ## What this page replaced
 *
 * A placeholder reading "Not available yet — the settings screens arrive with
 * Phase 2", shown while the sidebar beside it said Phase 8. Stale on both
 * counts, and the first screen an Owner opens.
 *
 * ## Why everything is read-only, and said so plainly
 *
 * Editing these values is a privileged write with an audit trail and a set of
 * cross-field rules the database already enforces, and it is not what
 * Phase 9 is for. Showing them is: an Owner needs to be able to answer "what
 * rate are we lending at?" without reading a migration, and every one of
 * these numbers is already the one the engines use.
 *
 * The page is explicit that a change here would affect **future** loans only.
 * That is the single most important thing a settings screen in a lending
 * system can say: an approved loan carries its own rate, grace period and
 * penalty rate, captured at approval and immutable afterwards, so dropping
 * the business rate tomorrow does not re-price anybody's existing debt.
 */
export default async function SettingsPage() {
  const context = await guardPermission(ROUTES.settings, 'settings:view');
  const { company, rules, cadences, unavailable } = await getSettingsSnapshot();

  const canEdit = contextCan(context, 'settings:update');

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title="Settings"
        description="What the business is configured to do. These are the values the loan, schedule and penalty engines read."
        status={<Badge tone="neutral">Read-only</Badge>}
      />

      <Alert tone="info" title="Changing a setting does not change an existing loan">
        Every loan records its own interest rate, grace period and penalty rate at the
        moment it is approved, and those figures never move afterwards. A change made here
        applies to loans approved <strong>after</strong> the change, which is why a loan
        from last month can be on a different rate from one approved today.
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
          { id: 'rules-heading', label: 'Lending' },
          { id: 'cadences-heading', label: 'Repayment' },
          { id: 'locale-heading', label: 'System' },
        ]}
      />

      {/* --- Company ---------------------------------------------------- */}
      <section aria-labelledby="company-heading">
        <SectionHeader
          id="company-heading"
          title="Company"
          description="Who the business is. Appears on receipts, statements and the application header."
        />

        {company === null ? (
          <Card>
            <p className="text-text-muted text-sm">
              The company record could not be read.
            </p>
          </Card>
        ) : (
          <Card>
            <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
              <Setting label="Trading name" value={company.companyName} />
              <Setting label="Registered name" value={company.legalName} />
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
              <Setting label="Email" value={company.email} />
              <Setting
                label="Address"
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
            </dl>
          </Card>
        )}
      </section>

      {/* --- Locale ----------------------------------------------------- */}
      <section aria-labelledby="locale-heading">
        <SectionHeader
          id="locale-heading"
          title="Currency, locale and business day"
          description="How figures and dates are written, and what the system means by “today”."
        />

        <Card>
          <dl className="grid min-w-0 gap-4 sm:grid-cols-3">
            <Setting label="Currency" value={company?.currencyCode ?? null} />
            <Setting label="Locale" value={company?.locale ?? null} />
            <Setting
              label="Business timezone"
              value={company?.timezone ?? null}
              hint="Decides which calendar day a payment lands on, and when a collection becomes overdue."
            />
          </dl>

          <p className="text-text-muted mt-4 text-sm">
            Today, in the business timezone, is{' '}
            <DateValue value={new Date()} timeZone={company?.timezone} />.
          </p>
        </Card>
      </section>

      {/* --- Lending rules ---------------------------------------------- */}
      <section aria-labelledby="rules-heading">
        <SectionHeader
          id="rules-heading"
          title="Lending rules"
          description="The defaults a new loan starts from, and the limits it must satisfy."
        />

        {rules === null ? (
          <Card>
            <p className="text-text-muted text-sm">
              The lending rules could not be read.
            </p>
          </Card>
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
                />
                <Setting
                  label="Guarantors required"
                  value={String(rules.minGuarantorsRequired)}
                />
              </dl>
            </Card>

            <Card>
              <CardHeader title="Interest and late payment" as="h3" />
              <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
                <Setting
                  label="Monthly interest rate"
                  value={formatBps(toBps(rules.defaultMonthlyInterestRateBps))}
                />
                <Setting
                  label="Interest method"
                  value={
                    rules.defaultInterestMethod === 'reducing_balance_monthly'
                      ? 'Reducing balance, monthly'
                      : rules.defaultInterestMethod
                  }
                />
                <Setting
                  label="Grace period"
                  value={`${String(rules.gracePeriodDays)} days`}
                  hint="After the final collection date, before a late-payment charge applies."
                />
                <Setting
                  label="Late-payment charge"
                  value={formatBps(toBps(rules.penaltyRateBps))}
                  hint="Charged once, on the balance outstanding when the grace period ends."
                />
              </dl>
            </Card>
          </div>
        )}
      </section>

      {/* --- Cadences --------------------------------------------------- */}
      <section aria-labelledby="cadences-heading">
        <SectionHeader
          id="cadences-heading"
          title="Repayment cadences"
          description="How often a borrower pays. A loan records its own cadence at approval."
        />

        <Card>
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
                    {cadence.key === rules?.defaultRepaymentFrequency ? (
                      <Badge tone="info">Default</Badge>
                    ) : null}
                    {cadence.isActive ? null : <Badge tone="neutral">Not offered</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {/* --- Editing ---------------------------------------------------- */}
      <section aria-labelledby="editing-heading">
        <SectionHeader id="editing-heading" title="Changing these values" />
        <Card>
          <div className="flex items-start gap-3">
            <span className="bg-surface-raised flex size-9 shrink-0 items-center justify-center rounded-lg">
              <Lock aria-hidden="true" className="text-text-muted size-4" />
            </span>
            <div className="min-w-0 text-sm">
              <p className="text-text">
                {canEdit
                  ? 'Your role may change these settings, but they are not editable from this screen yet.'
                  : 'Only the Owner / Administrator may change these settings.'}
              </p>
              <p className="text-text-muted mt-1">
                A change is a privileged write with its own audit record and its own
                cross-field rules — a maximum below a minimum, a term outside the
                permitted range — which the database enforces whatever asks it. Until the
                editing screen lands, an administrator changes these values directly and
                the change is recorded in the audit trail like any other.
              </p>
            </div>
          </div>
        </Card>
      </section>

      {/* --- This build ------------------------------------------------- */}
      {/* §108. Somewhere a person can read which version they are looking at.
          Without it, "it is still not showing my change" is an argument
          rather than a question — and on an installed progressive web app,
          where a stale service worker can serve yesterday's shell, it is the
          first thing worth checking. The same string is what `/api/health`
          reports, so a screen and a monitor can be compared. */}
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
