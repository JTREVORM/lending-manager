'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { Money } from '@/components/ui/money';
import {
  activateAgencyProviderAction,
  approveAgencyProviderTermsAction,
  deactivateAgencyProviderAction,
  registerAgencyAgentAccountAction,
  registerAgencyProviderAction,
  setAgencyFloatFacilityAction,
  setServiceThresholdAction,
  type AgencyActionResult,
} from '@/lib/agency/actions';
import {
  activationBlockers,
  type AgencyAgentAccountRegisterRow,
  type AgencyProviderReadinessRow,
  type AgencyServiceTypeRow,
  type OperatingBranchOption,
} from '@/lib/domain/agency';
import { cn } from '@/lib/utils/cn';

const SELECT =
  'border-border bg-surface focus-visible:ring-brand mt-1 h-11 w-full min-w-0 rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none';

/** The seven categories the chart of accounts is organised by. */
const CATEGORIES = [
  ['agency_banking', 'Agent banking — a partner bank', '4520'],
  ['mobile_money', 'Mobile money', '4510'],
  ['utility', 'A utility — water, electricity', '4530'],
  ['school_fees', 'School fees collection', '4540'],
  ['tv_subscription', 'TV subscription', '4550'],
  ['airtime_data', 'Airtime and data', '4560'],
  ['other', 'Something else', '4590'],
] as const;

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

/**
 * Registering a partner, and bringing it live.
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
  return (
    <div className={cn('min-w-0 space-y-4', className)}>
      <ReadinessTable readiness={readiness} />

      {canConfigure ? <RegisterProviderForm /> : null}

      {canApprove ? (
        <ApproveTermsForm
          providers={readiness.filter((p) => p.isProvisional)}
          confirmed={readiness.filter((p) => !p.isProvisional).length}
        />
      ) : null}

      {canApprove ? (
        <FacilityForm
          providers={readiness.filter(
            (p) => p.floatModel === 'provider_float' && !p.isProvisional,
          )}
        />
      ) : null}

      {canConfigure ? (
        <AgentAccountForm
          providers={readiness}
          branches={branches}
          accounts={agentAccounts}
        />
      ) : null}

      {canConfigure ? <ThresholdForm types={serviceTypes} /> : null}

      {canApprove ? <ActivationForms readiness={readiness} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// What is outstanding, per provider
// ---------------------------------------------------------------------------

function ReadinessTable({
  readiness,
}: {
  readonly readiness: readonly AgencyProviderReadinessRow[];
}) {
  return (
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
                    : ` · ${String(provider.servicesWithThreshold)} with an approval threshold`}
                </p>

                {provider.isActive ? (
                  <p className="text-text-muted mt-1 text-xs">
                    Authorized under {provider.activationReference ?? '—'}.
                  </p>
                ) : blockers.length === 0 ? (
                  <p className="text-text-muted mt-1 text-xs">
                    Its configuration is complete. Going live is a person&rsquo;s decision
                    and has to name the instrument it was given under.
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
  );
}

// ---------------------------------------------------------------------------
// 1. Registration
// ---------------------------------------------------------------------------

function RegisterProviderForm() {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(registerAgencyProviderAction, undefined);

  const [category, setCategory] = useState<string>('agency_banking');
  const [floatModel, setFloatModel] = useState<'provider_float' | 'cash_payable'>(
    'provider_float',
  );
  const [source, setSource] = useState<'configured' | 'reported'>('configured');

  const income = CATEGORIES.find(([value]) => value === category)?.[2] ?? '4590';

  return (
    <Card>
      <CardHeader
        title="Register a bank or other provider"
        description="Equity, Centenary, a utility, a school — anything the business collects or pays on behalf of."
      />

      <Alert tone="info" className="mb-3">
        Registering records the partner. It does <strong>not</strong> make it live: the
        provider is written as provisional and inactive, nothing can be posted against it,
        and both approving its terms and authorizing it to transact are separate decisions
        taken by somebody else.
      </Alert>

      {result?.message === undefined ? null : (
        <Alert tone={result.ok ? 'success' : 'danger'} className="mb-3">
          {result.message}
        </Alert>
      )}

      <form action={submit} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Field
          label="Short code"
          name="code"
          required
          hint="2 to 32 letters, digits or underscores, such as EQUITY or CENTENARY. It becomes part of the float account’s code and cannot be changed later."
        />
        <Field label="Name" name="name" required />

        <div className="min-w-0">
          <Label htmlFor="register-category">Category</Label>
          <select
            id="register-category"
            name="category"
            required
            className={SELECT}
            value={category}
            onChange={(event) => {
              setCategory(event.target.value);
            }}
          >
            {CATEGORIES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <p className="text-text-muted mt-1 text-xs">
            The category decides the ledger accounts: commission will be recognised in{' '}
            <span className="font-mono">{income}</span>. It is not a choice, because
            filing a bank&rsquo;s commission under mobile money passes every check in the
            schema and makes the two inseparable for the rest of time.
          </p>
        </div>

        <div className="min-w-0">
          <Label htmlFor="register-float-model">Where the money sits</Label>
          <select
            id="register-float-model"
            name="floatModel"
            required
            className={SELECT}
            value={floatModel}
            onChange={(event) => {
              setFloatModel(
                event.target.value === 'cash_payable' ? 'cash_payable' : 'provider_float',
              );
            }}
          >
            <option value="provider_float">
              The partner advances electronic float to the agent
            </option>
            <option value="cash_payable">
              The business holds the customer&rsquo;s cash and owes it onward
            </option>
          </select>
          <p className="text-text-muted mt-1 text-xs">
            {floatModel === 'provider_float'
              ? 'Each agent account will own its own float account in the 1320 series.'
              : 'No float account is created: the business holds no electronic float for this partner, and each agent account carries the partner’s own account number instead.'}
          </p>
        </div>

        <div className="min-w-0">
          <Label htmlFor="register-commission-model">Commission is recognised</Label>
          <select
            id="register-commission-model"
            name="commissionModel"
            required
            className={SELECT}
            defaultValue="deferred"
          >
            <option value="deferred">
              When the partner remits it — accrued as receivable until then
            </option>
            <option value="immediate">At the point of sale</option>
          </select>
        </div>

        <div className="min-w-0">
          <Label htmlFor="register-commission-source">And it is computed</Label>
          <select
            id="register-commission-source"
            name="commissionSource"
            required
            className={SELECT}
            value={source}
            onChange={(event) => {
              setSource(event.target.value === 'reported' ? 'reported' : 'configured');
            }}
          >
            <option value="configured">From the terms recorded here</option>
            <option value="reported">
              Read off the partner&rsquo;s own statement, per transaction
            </option>
          </select>
        </div>

        {source === 'configured' ? (
          <>
            <Field
              label="Rate"
              name="commissionRateBps"
              inputMode="numeric"
              hint="In basis points: 150 is 1.5%. Leave blank if the partner pays a flat fee instead."
            />
            <Field
              label="Or a flat amount a transaction"
              name="commissionFixed"
              inputMode="numeric"
            />
          </>
        ) : (
          <div className="min-w-0 sm:col-span-2">
            <Alert tone="info">
              A partner that reports its own commission records no rate here. The figure
              arrives with each transaction and is mandatory there instead.
            </Alert>
          </div>
        )}

        <div className="sm:col-span-2">
          <Field
            label="Agreement reference"
            name="termsReference"
            hint="How to find the signed agreement. Not required to register, and required before the terms can be approved."
          />
        </div>

        <div className="sm:col-span-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'Registering…' : 'Register provider'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 2. Approving the commercial terms
// ---------------------------------------------------------------------------

function ApproveTermsForm({
  providers,
  confirmed,
}: {
  readonly providers: readonly AgencyProviderReadinessRow[];
  readonly confirmed: number;
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(approveAgencyProviderTermsAction, undefined);

  return (
    <Card>
      <CardHeader
        title="Approve a provider’s commercial terms"
        description="Check the commission against the signed agreement, and say so on the record."
      />

      <Alert tone="warning" className="mb-3">
        <strong>You cannot approve a provider you registered.</strong> The commission rate
        is the one number that decides what every future transaction earns, the agreement
        is held outside POLYTOS, and nothing in the system will ever notice a mistyped
        rate. So a second Owner or Administrator checks the number against the paper.
      </Alert>

      {result?.message === undefined ? null : (
        <Alert tone={result.ok ? 'success' : 'danger'} className="mb-3">
          {result.message}
        </Alert>
      )}

      {providers.length === 0 ? (
        <p className="text-text-muted text-sm">
          No provider is awaiting approval.
          {confirmed === 0
            ? ''
            : ` ${String(confirmed)} ${confirmed === 1 ? 'has' : 'have'} approved terms already.`}
        </p>
      ) : (
        <form action={submit} className="grid min-w-0 gap-4 sm:grid-cols-2">
          <div className="min-w-0 sm:col-span-2">
            <Label htmlFor="approve-provider">Provider</Label>
            <select
              id="approve-provider"
              name="providerId"
              required
              className={SELECT}
              defaultValue=""
            >
              <option value="">Choose a provider awaiting approval…</option>
              {providers.map((provider) => (
                <option key={provider.providerId} value={provider.providerId}>
                  {provider.providerName} —{' '}
                  {provider.commissionSource === 'reported'
                    ? 'reports its own commission'
                    : provider.commissionRateBps !== null
                      ? `${(provider.commissionRateBps / 100).toFixed(2)}% of the amount`
                      : provider.commissionFixed !== null
                        ? 'a flat amount a transaction'
                        : 'no terms recorded'}
                </option>
              ))}
            </select>
          </div>

          <Field
            label="Agreement reference"
            name="termsReference"
            required
            hint="The contract or agreement number you checked the terms against."
          />
          <Field
            label="What you checked"
            name="note"
            hint="Kept on the record, for whoever reads this in a year."
          />

          <div className="sm:col-span-2">
            <Button type="submit" disabled={pending}>
              {pending ? 'Approving…' : 'Approve terms'}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 3. The float facility
// ---------------------------------------------------------------------------

function FacilityForm({
  providers,
}: {
  readonly providers: readonly AgencyProviderReadinessRow[];
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(setAgencyFloatFacilityAction, undefined);

  return (
    <Card>
      <CardHeader
        title="Approve a float facility"
        description="The most electronic float the partner has agreed to advance, across every agent account."
      />

      <Alert tone="info" className="mb-3">
        Float cannot be replenished or purchased above this figure once it is set. It is
        granted by the partner to the business, so it is one limit per partner rather than
        one per outlet — the business decides how to spread it.
      </Alert>

      {result?.message === undefined ? null : (
        <Alert tone={result.ok ? 'success' : 'danger'} className="mb-3">
          {result.message}
        </Alert>
      )}

      {providers.length === 0 ? (
        <p className="text-text-muted text-sm">
          No provider with approved terms advances float. A partner that holds the
          customer&rsquo;s cash has no facility to approve: it advances nothing.
        </p>
      ) : (
        <form action={submit} className="grid min-w-0 gap-4 sm:grid-cols-2">
          <div className="min-w-0 sm:col-span-2">
            <Label htmlFor="facility-provider">Provider</Label>
            <select
              id="facility-provider"
              name="providerId"
              required
              className={SELECT}
              defaultValue=""
            >
              <option value="">Choose a provider…</option>
              {providers.map((provider) => (
                <option key={provider.providerId} value={provider.providerId}>
                  {provider.providerName}
                  {provider.floatFacilityLimit === null
                    ? ' — no facility approved'
                    : ' — a facility is already approved'}
                </option>
              ))}
            </select>
          </div>

          <Field
            label="Facility"
            name="limit"
            inputMode="numeric"
            required
            hint="Whole shillings. It cannot be set below the float already held."
          />
          <Field
            label="Granted under"
            name="reference"
            required
            hint="The facility letter or agreement. POLYTOS does not hold it, so the record has to say where it is."
          />

          <div className="sm:col-span-2">
            <Field label="Note" name="note" />
          </div>

          <div className="sm:col-span-2">
            <Button type="submit" disabled={pending}>
              {pending ? 'Approving…' : 'Approve facility'}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 4. Agent accounts
// ---------------------------------------------------------------------------

function AgentAccountForm({
  providers,
  branches,
  accounts,
}: {
  readonly providers: readonly AgencyProviderReadinessRow[];
  readonly branches: readonly OperatingBranchOption[];
  readonly accounts: readonly AgencyAgentAccountRegisterRow[];
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(registerAgencyAgentAccountAction, undefined);

  const [providerId, setProviderId] = useState('');
  const chosen = providers.find((p) => p.providerId === providerId) ?? null;
  const holdsFloat = chosen === null || chosen.floatModel === 'provider_float';

  return (
    <Card>
      <CardHeader
        title="Register an agent account"
        description="A counter, a till, a collection point. One per location, and as many locations as the partner has given."
      />

      {result?.message === undefined ? null : (
        <Alert tone={result.ok ? 'success' : 'danger'} className="mb-3">
          {result.message}
        </Alert>
      )}

      {providers.length === 0 || branches.length === 0 ? (
        <p className="text-text-muted text-sm">
          A provider and a branch are both needed before an agent account can be opened.
        </p>
      ) : (
        <form action={submit} className="grid min-w-0 gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <Label htmlFor="agent-provider">Provider</Label>
            <select
              id="agent-provider"
              name="providerId"
              required
              className={SELECT}
              value={providerId}
              onChange={(event) => {
                setProviderId(event.target.value);
              }}
            >
              <option value="">Choose a provider…</option>
              {providers.map((provider) => (
                <option key={provider.providerId} value={provider.providerId}>
                  {provider.providerName}
                </option>
              ))}
            </select>
          </div>

          <div className="min-w-0">
            <Label htmlFor="agent-branch">Location</Label>
            <select
              id="agent-branch"
              name="branchId"
              required
              className={SELECT}
              defaultValue={branches[0]?.id ?? ''}
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.branchCode} — {b.name}
                </option>
              ))}
            </select>
          </div>

          <Field
            label="Account name"
            name="tillName"
            required
            hint="Lower case letters, digits, hyphens or underscores: main, gate1, counter-2. It becomes part of the ledger account’s code and cannot be renamed."
          />
          <Field label="Label" name="label" hint="What staff call it." />

          <Field
            label="Agent identifier"
            name="agentCode"
            hint="The identifier the partner issued for this outlet."
          />
          <Field
            label="The partner’s account number"
            name="bankAccountNumber"
            required={!holdsFloat}
            hint={
              holdsFloat
                ? 'Optional where the account holds float: it already has a float account of its own.'
                : 'Required: this partner advances no float, so the account number is the only record of where the money is owed.'
            }
          />

          <Field
            label="Line number"
            name="lineMsisdn"
            hint="A mobile money line, as +256XXXXXXXXX. Leave blank for a bank counter."
          />
          <Field label="Opened on" name="openedOn" type="date" />

          <div className="sm:col-span-2">
            <Field label="Notes" name="notes" />
          </div>

          <div className="sm:col-span-2">
            <Button type="submit" disabled={pending}>
              {pending ? 'Registering…' : 'Register agent account'}
            </Button>
          </div>
        </form>
      )}

      {accounts.length === 0 ? null : (
        <div className="border-border mt-4 min-w-0 border-t pt-3">
          <p className="text-text text-xs font-semibold">Registered agent accounts</p>
          <ul className="text-text-muted mt-2 space-y-1 text-xs">
            {accounts.map((account) => (
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
  );
}

// ---------------------------------------------------------------------------
// 5. The approval threshold
// ---------------------------------------------------------------------------

function ThresholdForm({ types }: { readonly types: readonly AgencyServiceTypeRow[] }) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(setServiceThresholdAction, undefined);

  const eligible = types.filter((t) => t.maxSingleTransaction !== null);

  return (
    <Card>
      <CardHeader
        title="Set an approval threshold"
        description="The amount above which only the Owner may verify a transaction."
      />

      <Alert tone="info" className="mb-3">
        Different from the ceiling. The ceiling says what may be transacted at all and the
        database refuses past it. The threshold says what may be transacted{' '}
        <em>without the Owner looking at it</em>: above it, ordinary verification is
        refused and somebody holding the high-value capability has to post it.
      </Alert>

      {result?.message === undefined ? null : (
        <Alert tone={result.ok ? 'success' : 'danger'} className="mb-3">
          {result.message}
        </Alert>
      )}

      {eligible.length === 0 ? (
        <p className="text-text-muted text-sm">
          No service states a ceiling yet. A threshold has to sit below one, or it could
          never be reached.
        </p>
      ) : (
        <form action={submit} className="grid min-w-0 gap-4 sm:grid-cols-2">
          <div className="min-w-0 sm:col-span-2">
            <Label htmlFor="threshold-type">Service</Label>
            <select
              id="threshold-type"
              name="transactionTypeId"
              required
              className={SELECT}
              defaultValue=""
            >
              <option value="">Choose a service…</option>
              {eligible.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.providerName} · {type.name}
                  {type.requiresApprovalAbove === null
                    ? ''
                    : ' — a threshold is already set'}
                </option>
              ))}
            </select>
          </div>

          <Field
            label="Owner must verify above"
            name="requiresApprovalAbove"
            inputMode="numeric"
            required
            hint="Whole shillings, below the service’s own ceiling."
          />
          <Field label="Because" name="reason" />

          <div className="sm:col-span-2">
            <Button type="submit" disabled={pending}>
              {pending ? 'Setting…' : 'Set threshold'}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 6. Going live, and coming back out
// ---------------------------------------------------------------------------

function ActivationForms({
  readiness,
}: {
  readonly readiness: readonly AgencyProviderReadinessRow[];
}) {
  const [liveResult, goLive, goingLive] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(activateAgencyProviderAction, undefined);
  const [offResult, takeOff, takingOff] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(deactivateAgencyProviderAction, undefined);

  const ready = readiness.filter((p) => !p.isActive && p.readyToActivate);
  const live = readiness.filter((p) => p.isActive);

  return (
    <Card>
      <CardHeader
        title="Make a provider live, or take it out of service"
        description="The last decision, and the only one that lets customer money move."
      />

      <Alert tone="warning" className="mb-3">
        <strong>You cannot authorize a provider you registered.</strong> Going live means
        the business is ready to transact on this partner&rsquo;s behalf — a different
        judgement from approving what it pays, with its own preconditions, and it has to
        name the instrument it was authorized under.
      </Alert>

      {liveResult?.message === undefined ? null : (
        <Alert tone={liveResult.ok ? 'success' : 'danger'} className="mb-3">
          {liveResult.message}
        </Alert>
      )}

      {ready.length === 0 ? (
        <p className="text-text-muted text-sm">
          No provider&rsquo;s configuration is complete. The list above says what each one
          is still missing.
        </p>
      ) : (
        <form action={goLive} className="grid min-w-0 gap-4 sm:grid-cols-2">
          <div className="min-w-0 sm:col-span-2">
            <Label htmlFor="activate-provider">Provider</Label>
            <select
              id="activate-provider"
              name="providerId"
              required
              className={SELECT}
              defaultValue=""
            >
              <option value="">Choose a provider…</option>
              {ready.map((provider) => (
                <option key={provider.providerId} value={provider.providerId}>
                  {provider.providerName}
                </option>
              ))}
            </select>
          </div>

          <Field
            label="Authorized under"
            name="authorizationReference"
            required
            hint="A board minute, a signed authority, a dated instruction. “Somebody switched it on” is not an authorization."
          />
          <Field label="Note" name="note" />

          <div className="sm:col-span-2">
            <Button type="submit" disabled={goingLive}>
              {goingLive ? 'Authorizing…' : 'Make live'}
            </Button>
          </div>
        </form>
      )}

      {live.length === 0 ? null : (
        <div className="border-border mt-4 min-w-0 border-t pt-4">
          {offResult?.message === undefined ? null : (
            <Alert tone={offResult.ok ? 'success' : 'danger'} className="mb-3">
              {offResult.message}
            </Alert>
          )}

          <form action={takeOff} className="grid min-w-0 gap-4 sm:grid-cols-2">
            <div className="min-w-0 sm:col-span-2">
              <Label htmlFor="deactivate-provider">Take out of service</Label>
              <select
                id="deactivate-provider"
                name="providerId"
                required
                className={SELECT}
                defaultValue=""
              >
                <option value="">Choose a live provider…</option>
                {live.map((provider) => (
                  <option key={provider.providerId} value={provider.providerId}>
                    {provider.providerName}
                  </option>
                ))}
              </select>
              <p className="text-text-muted mt-1 text-xs">
                Nothing further may be posted against it. Corrections to what is already
                posted stay possible, and its authorization is cleared — going live again
                is a new decision.
              </p>
            </div>

            <div className="sm:col-span-2">
              <Field label="Because" name="reason" required />
            </div>

            <div className="sm:col-span-2">
              <Button type="submit" variant="secondary" disabled={takingOff}>
                {takingOff ? 'Working…' : 'Take out of service'}
              </Button>
            </div>
          </form>
        </div>
      )}
    </Card>
  );
}
