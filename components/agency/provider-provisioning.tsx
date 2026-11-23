import {
  ActivateForm,
  AgentAccountForm,
  ApproveTermsForm,
  DeactivateForm,
  FacilityForm,
  RegisterProviderForm,
  ThresholdForm,
  type CategoryOption,
  type FormOption,
} from '@/components/agency/provisioning-forms';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import {
  activationBlockers,
  type AgencyAgentAccountRegisterRow,
  type AgencyProviderReadinessRow,
  type AgencyServiceTypeRow,
  type OperatingBranchOption,
} from '@/lib/domain/agency';
import { cn } from '@/lib/utils/cn';

/**
 * The seven categories the chart of accounts is organised by, and the account
 * each one's commission lands in.
 *
 * Server-side, so the words and the account codes are not in the browser's
 * bundle. The mapping itself is the database's — `agency_category_income_code()`
 * is the authority and refuses anything else — and this is the same table
 * written for a reader.
 */
const CATEGORIES: readonly CategoryOption[] = [
  { id: 'agency_banking', label: 'Agent banking — a partner bank', income: '4520' },
  { id: 'mobile_money', label: 'Mobile money', income: '4510' },
  { id: 'utility', label: 'A utility — water, electricity', income: '4530' },
  { id: 'school_fees', label: 'School fees collection', income: '4540' },
  { id: 'tv_subscription', label: 'TV subscription', income: '4550' },
  { id: 'airtime_data', label: 'Airtime and data', income: '4560' },
  { id: 'other', label: 'Something else', income: '4590' },
];

/**
 * The two models, the two recognition points and the two commission sources,
 * described once, on the server.
 *
 * Every other select on this screen gets its option text from here; these
 * three used to describe themselves in the browser, which put six sentences
 * in the client chunk for no reason.
 */
const FLOAT_MODELS: readonly FormOption[] = [
  { id: 'provider_float', label: 'The partner advances electronic float to the agent' },
  {
    id: 'cash_payable',
    label: 'The business holds the customer’s cash and owes it onward',
  },
];

const COMMISSION_MODELS: readonly FormOption[] = [
  { id: 'deferred', label: 'When the partner remits it' },
  { id: 'immediate', label: 'At the point of sale' },
];

const COMMISSION_SOURCES: readonly FormOption[] = [
  { id: 'configured', label: 'From the terms recorded here' },
  { id: 'reported', label: 'Read off the partner’s own statement' },
];

export interface ProviderProvisioningProps {
  readonly readiness: readonly AgencyProviderReadinessRow[];
  readonly agentAccounts: readonly AgencyAgentAccountRegisterRow[];
  readonly serviceTypes: readonly AgencyServiceTypeRow[];
  readonly branches: readonly OperatingBranchOption[];
  /** Holds `agency:providers`: may register and configure. */
  readonly canConfigure: boolean;
  /** Holds `agency:provider_approval`: may approve terms, the facility, go-live. */
  readonly canApprove: boolean;
  readonly className?: string;
}

/** What a provider's terms currently say, in one phrase. */
function termsPhrase(provider: AgencyProviderReadinessRow): string {
  if (provider.commissionSource === 'reported') return 'reports its own commission';
  if (provider.commissionRateBps !== null) {
    return `${(provider.commissionRateBps / 100).toFixed(2)}% of the amount`;
  }
  if (provider.commissionFixed !== null) return 'a flat amount a transaction';
  return 'no terms recorded';
}

/**
 * Registering a partner, and bringing it live.
 *
 * ## A Server Component, and why that matters here
 *
 * This file ships **no JavaScript**. Every heading, every explanatory panel,
 * the readiness table, the list of registered agent accounts and the text of
 * every select option are rendered on the server; only the forms themselves
 * run in the browser, from `provisioning-forms.tsx`.
 *
 * The first version was one 942-line client component — tables, prose and all
 * — costing 10 KB gzipped, and it put the application over the bundle total
 * `tests/integration/bundle.test.ts` enforces. The budget's own notes record
 * the rule it was breaking: the daily commission report "is the largest piece
 * of work in this round by line count and it ships no JavaScript".
 *
 * ## Why this is one screen and not five
 *
 * Because it is one decision made in stages, and the stages depend on each
 * other. An Owner who registers Equity Bank needs to know, without leaving
 * the page, that its terms are not approved yet, that the facility is the
 * next thing, and that going live will be refused until an agent account
 * exists. Five screens would each be a dead end with a refusal at the bottom.
 *
 * ## Why no control is hidden for a provider it would refuse
 *
 * Every real gate is in the database. A screen that hid a button would be
 * deciding from data read when the page rendered, and would say nothing about
 * why. What this screen does instead is *list what is outstanding* per
 * provider, from `agency_provider_readiness`, so the refusal is never the
 * first the Owner hears of it.
 *
 * The two capabilities are separated, though, because that separation is the
 * control: `agency:providers` registers a partner and proposes what it pays,
 * `agency:provider_approval` confirms those terms and authorizes the
 * provider. The database refuses the *person* who registered a provider from
 * approving it, which no screen can know in advance — so the panels are shown
 * and the refusal, when it comes, says to ask a colleague.
 */
export function ProviderProvisioning({
  readiness,
  agentAccounts,
  serviceTypes,
  branches,
  canConfigure,
  canApprove,
  className,
}: ProviderProvisioningProps) {
  const provisional = readiness.filter((p) => p.isProvisional);
  const confirmed = readiness.filter((p) => !p.isProvisional);
  const facilityProviders = confirmed.filter((p) => p.floatModel === 'provider_float');
  const ready = readiness.filter((p) => !p.isActive && p.readyToActivate);
  const live = readiness.filter((p) => p.isActive);
  const thresholdable = serviceTypes.filter((t) => t.maxSingleTransaction !== null);

  const approveOptions: readonly FormOption[] = provisional.map((p) => ({
    id: p.providerId,
    label: `${p.providerName} — ${termsPhrase(p)}`,
  }));

  const facilityOptions: readonly FormOption[] = facilityProviders.map((p) => ({
    id: p.providerId,
    label:
      p.floatFacilityLimit === null
        ? `${p.providerName} — no facility approved`
        : `${p.providerName} — a facility is already approved`,
  }));

  const agentProviderOptions = readiness.map((p) => ({
    id: p.providerId,
    label: p.providerName,
    holdsFloat: p.floatModel === 'provider_float',
  }));

  const branchOptions: readonly FormOption[] = branches.map((b) => ({
    id: b.id,
    label: `${b.branchCode} — ${b.name}`,
  }));

  const thresholdOptions: readonly FormOption[] = thresholdable.map((t) => ({
    id: t.id,
    label: `${t.providerName} · ${t.name}${
      t.requiresApprovalAbove === null ? '' : ' — a threshold is already set'
    }`,
  }));

  const liveOptions: readonly FormOption[] = ready.map((p) => ({
    id: p.providerId,
    label: p.providerName,
  }));

  const offOptions: readonly FormOption[] = live.map((p) => ({
    id: p.providerId,
    label: p.providerName,
  }));

  return (
    <div className={cn('min-w-0 space-y-4', className)}>
      <Card>
        <CardHeader
          title="What each provider still needs"
          description="Every condition the database checks before a provider may go live, answered separately."
        />

        {readiness.length === 0 ? (
          <p className="text-text-muted text-sm">No provider is registered.</p>
        ) : (
          <ul className="divide-border min-w-0 divide-y">
            {readiness.map((provider) => {
              const blockers = activationBlockers(provider);
              return (
                <li key={provider.providerId} className="min-w-0 py-3">
                  <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
                    <p className="text-text text-sm font-medium">
                      {provider.providerName}{' '}
                      <span className="text-text-muted font-mono text-xs">
                        {provider.providerCode}
                      </span>
                    </p>
                    <Badge
                      tone={
                        provider.isActive
                          ? 'success'
                          : blockers.length === 0
                            ? 'info'
                            : 'neutral'
                      }
                      shape="pill"
                    >
                      {provider.isActive
                        ? 'Live'
                        : blockers.length === 0
                          ? 'Ready — awaiting authorization'
                          : 'Not ready'}
                    </Badge>
                  </div>

                  <p className="text-text-muted mt-1 text-xs">
                    {provider.floatModel === 'provider_float'
                      ? 'Advances electronic float'
                      : 'Holds the customer’s cash and owes it onward'}
                    {provider.floatFacilityLimit === null ? null : (
                      <>
                        {' · facility '}
                        <Money amount={provider.floatFacilityLimit} />
                        {' · holding '}
                        <Money amount={provider.floatHeld} />
                      </>
                    )}
                    {` · ${String(provider.openAgentAccounts)} open agent account(s)`}
                    {` · ${String(provider.servicesWithCeiling)} service(s) with a ceiling`}
                    {provider.servicesWithThreshold === 0
                      ? ''
                      : ` · ${String(provider.servicesWithThreshold)} needing a second approval`}
                  </p>

                  {provider.isActive ? (
                    <p className="text-text-muted mt-1 text-xs">
                      Authorized under {provider.activationReference ?? '—'}.
                    </p>
                  ) : blockers.length === 0 ? (
                    <p className="text-text-muted mt-1 text-xs">
                      Its configuration is complete. Going live is a person&rsquo;s
                      decision and has to name the instrument it was given under.
                    </p>
                  ) : (
                    <ul className="text-text-muted mt-1 list-disc space-y-0.5 pl-5 text-xs">
                      {blockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  )}

                  {provider.deactivationReason === null || provider.isActive ? null : (
                    <p className="text-text-muted mt-1 text-xs">
                      Taken out of service: {provider.deactivationReason}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {canConfigure ? (
        <Card>
          <CardHeader
            title="Register a bank or other provider"
            description="Equity, Centenary, a utility, a school — anything the business collects or pays on behalf of."
          />
          <Alert tone="info" className="mb-3">
            Registering records the partner. It does <strong>not</strong> make it live:
            the provider is written as provisional and inactive, nothing can be posted
            against it, and both approving its terms and authorizing it to transact are
            separate decisions taken by somebody else.
          </Alert>
          <p className="text-text-muted mb-3 text-xs">
            The category is not a free choice of ledger account: filing a bank&rsquo;s
            commission under mobile money passes every check in the schema and makes the
            two inseparable for the rest of time, so the category decides the accounts.
            The short code becomes part of the float account&rsquo;s own code, which is
            why neither it nor an agent account&rsquo;s name can be changed afterwards.
          </p>
          <RegisterProviderForm
            categories={CATEGORIES}
            floatModels={FLOAT_MODELS}
            commissionModels={COMMISSION_MODELS}
            commissionSources={COMMISSION_SOURCES}
          />
        </Card>
      ) : null}

      {canApprove ? (
        <Card>
          <CardHeader
            title="Approve a provider’s commercial terms"
            description="Check the commission against the signed agreement, and say so on the record."
          />
          <Alert tone="warning" className="mb-3">
            <strong>You cannot approve a provider you registered.</strong> The commission
            rate is the one number that decides what every future transaction earns, the
            agreement is held outside POLYTOS, and nothing in the system will ever notice
            a mistyped rate. So a second Owner or Administrator checks the number against
            the paper.
          </Alert>
          {approveOptions.length === 0 ? (
            <p className="text-text-muted text-sm">
              No provider is awaiting approval.
              {confirmed.length === 0
                ? ''
                : ` ${String(confirmed.length)} ${confirmed.length === 1 ? 'has' : 'have'} approved terms already.`}
            </p>
          ) : (
            <ApproveTermsForm options={approveOptions} />
          )}
        </Card>
      ) : null}

      {canApprove ? (
        <Card>
          <CardHeader
            title="Approve a float facility"
            description="The most electronic float the partner has agreed to advance, across every agent account."
          />
          <Alert tone="info" className="mb-3">
            Float cannot be replenished or purchased above this figure once it is set. It
            is granted by the partner to the business, so it is one limit per partner
            rather than one per outlet — the business decides how to spread it.
          </Alert>
          {facilityOptions.length === 0 ? (
            <p className="text-text-muted text-sm">
              No provider with approved terms advances float. A partner that holds the
              customer&rsquo;s cash has no facility to approve: it advances nothing.
            </p>
          ) : (
            <FacilityForm options={facilityOptions} />
          )}
        </Card>
      ) : null}

      {canConfigure ? (
        <Card>
          <CardHeader
            title="Register an agent account"
            description="A counter, a till, a collection point. One per location, and as many locations as the partner has given."
          />
          {agentProviderOptions.length === 0 || branchOptions.length === 0 ? (
            <p className="text-text-muted text-sm">
              A provider and a branch are both needed before an agent account can be
              opened.
            </p>
          ) : (
            <AgentAccountForm providers={agentProviderOptions} branches={branchOptions} />
          )}

          {agentAccounts.length === 0 ? null : (
            <div className="border-border mt-4 min-w-0 border-t pt-3">
              <p className="text-text text-xs font-semibold">Registered agent accounts</p>
              <ul className="text-text-muted mt-2 space-y-1 text-xs">
                {agentAccounts.map((account) => (
                  <li key={account.agentAccountId} className="min-w-0">
                    {account.providerName} · {account.branchCode} · {account.tillName}
                    {account.agentCode === null ? '' : ` · agent ${account.agentCode}`}
                    {account.bankAccountNumber === null
                      ? ''
                      : ` · account ${account.bankAccountNumber}`}
                    {account.holdsFloat
                      ? ` · float ${String(account.floatAccountCode)}`
                      : ' · holds no float'}
                    {` · ${String(account.activeStaff)} staff`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      ) : null}

      {canConfigure ? (
        <Card>
          <CardHeader
            title="Set an approval threshold"
            description="The amount above which an independent Manager or Owner must verify a transaction."
          />
          <Alert tone="info" className="mb-3">
            Different from the ceiling. The ceiling says what may be transacted at all and
            the database refuses past it. The threshold says what needs a{' '}
            <em>second, independent approval</em>: above it, verification requires the
            high-value capability, which the Manager and the Owner hold and which is never
            the officer who recorded the transaction.
          </Alert>
          {thresholdOptions.length === 0 ? (
            <p className="text-text-muted text-sm">
              No service states a ceiling yet. A threshold has to sit below one, or it
              could never be reached.
            </p>
          ) : (
            <ThresholdForm options={thresholdOptions} />
          )}
        </Card>
      ) : null}

      {canApprove ? (
        <Card>
          <CardHeader
            title="Make a provider live, or take it out of service"
            description="The last decision, and the only one that lets customer money move."
          />
          <Alert tone="warning" className="mb-3">
            <strong>You cannot authorize a provider you registered.</strong> Going live
            means the business is ready to transact on this partner&rsquo;s behalf — a
            different judgement from approving what it pays, with its own preconditions,
            and it has to name the instrument it was authorized under.
          </Alert>

          {liveOptions.length === 0 ? (
            <p className="text-text-muted text-sm">
              No provider&rsquo;s configuration is complete. The list above says what each
              one is still missing.
            </p>
          ) : (
            <ActivateForm options={liveOptions} />
          )}

          {offOptions.length === 0 ? null : (
            <div className="border-border mt-4 min-w-0 border-t pt-4">
              <p className="text-text-muted mb-2 text-xs">
                Taking a provider out of service stops every new posting against it.
                Corrections to what is already posted stay possible, and its authorization
                is cleared — going live again is a new decision.
              </p>
              <DeactivateForm options={offOptions} />
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
