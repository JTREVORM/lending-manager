'use client';

import { useActionState, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
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

/**
 * The parts of the provisioning workflow that have to run in the browser.
 *
 * ## Why this file is only forms
 *
 * Every heading, every explanatory panel, the readiness table and the list of
 * registered agent accounts are Server Components in
 * `provider-provisioning.tsx` and ship no JavaScript.
 * `tests/integration/bundle.test.ts` caps the total of every chunk the
 * application has, and the first version of this screen put all 942 lines
 * behind `'use client'` — prose, tables and all — for 10 KB gzipped.
 *
 * ## Why the options arrive as strings
 *
 * Each select used to describe its own choices: the terms-approval form
 * computed "1.50% of the amount" or "reports its own commission" per
 * provider, in the browser. That describing is now done on the server and
 * arrives as `{ id, label }`, which takes the unique sentences out of this
 * chunk and leaves the forms as forms. It also means the words a reader sees
 * are rendered in the same place as every other word on the screen.
 */

const SELECT =
  'border-border bg-surface focus-visible:ring-brand mt-1 h-11 w-full min-w-0 rounded-lg border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none';

/** One choice in a select: what to submit, and what to read. */
export interface FormOption {
  readonly id: string;
  readonly label: string;
}

/** A category to register against, and the account its commission lands in. */
export interface CategoryOption extends FormOption {
  readonly income: string;
}

function Result({ result }: { readonly result: AgencyActionResult | undefined }) {
  if (result?.message === undefined) return null;
  return (
    <Alert tone={result.ok ? 'success' : 'danger'} className="mb-3">
      {result.message}
    </Alert>
  );
}

function Chooser({
  id,
  name,
  label,
  placeholder,
  options,
}: {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly placeholder: string;
  readonly options: readonly FormOption[];
}) {
  return (
    <div className="min-w-0 sm:col-span-2">
      <Label htmlFor={id}>{label}</Label>
      <select id={id} name={name} required className={SELECT} defaultValue="">
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Registration
// ---------------------------------------------------------------------------

export function RegisterProviderForm({
  categories,
}: {
  readonly categories: readonly CategoryOption[];
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(registerAgencyProviderAction, undefined);

  const [category, setCategory] = useState<string>(categories[0]?.id ?? 'agency_banking');
  const [floatModel, setFloatModel] = useState<'provider_float' | 'cash_payable'>(
    'provider_float',
  );
  const [source, setSource] = useState<'configured' | 'reported'>('configured');

  const income = categories.find((c) => c.id === category)?.income ?? '4590';

  return (
    <>
      <Result result={result} />

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
            {categories.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="text-text-muted mt-1 text-xs">
            The category decides the ledger accounts: commission will be recognised in{' '}
            <span className="font-mono">{income}</span>.
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
            <option value="deferred">When the partner remits it</option>
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
            <option value="reported">Read off the partner&rsquo;s own statement</option>
          </select>
        </div>

        {source === 'configured' ? (
          <>
            <Field
              label="Rate"
              name="commissionRateBps"
              inputMode="numeric"
              hint="In basis points: 150 is 1.5%. Leave blank for a flat fee instead."
            />
            <Field
              label="Or a flat amount a transaction"
              name="commissionFixed"
              inputMode="numeric"
            />
          </>
        ) : null}

        <div className="sm:col-span-2">
          <Field
            label="Agreement reference"
            name="termsReference"
            hint="How to find the signed agreement. Required before the terms can be approved."
          />
        </div>

        <div className="sm:col-span-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'Registering…' : 'Register provider'}
          </Button>
        </div>
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------
// 2. Approving the commercial terms
// ---------------------------------------------------------------------------

export function ApproveTermsForm({
  options,
}: {
  readonly options: readonly FormOption[];
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(approveAgencyProviderTermsAction, undefined);

  return (
    <>
      <Result result={result} />
      <form action={submit} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Chooser
          id="approve-provider"
          name="providerId"
          label="Provider whose terms to approve"
          placeholder="Choose a provider awaiting approval…"
          options={options}
        />
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
    </>
  );
}

// ---------------------------------------------------------------------------
// 3. The float facility
// ---------------------------------------------------------------------------

export function FacilityForm({ options }: { readonly options: readonly FormOption[] }) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(setAgencyFloatFacilityAction, undefined);

  return (
    <>
      <Result result={result} />
      <form action={submit} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Chooser
          id="facility-provider"
          name="providerId"
          label="Provider to approve a facility for"
          placeholder="Choose a provider…"
          options={options}
        />
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
    </>
  );
}

// ---------------------------------------------------------------------------
// 4. Agent accounts
// ---------------------------------------------------------------------------

export function AgentAccountForm({
  providers,
  branches,
}: {
  readonly providers: readonly (FormOption & { readonly holdsFloat: boolean })[];
  readonly branches: readonly FormOption[];
}) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(registerAgencyAgentAccountAction, undefined);

  const [providerId, setProviderId] = useState('');
  const chosen = providers.find((p) => p.id === providerId) ?? null;
  const holdsFloat = chosen === null || chosen.holdsFloat;

  return (
    <>
      <Result result={result} />
      <form action={submit} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <Label htmlFor="agent-provider">Provider for this agent account</Label>
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
              <option key={provider.id} value={provider.id}>
                {provider.label}
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
                {b.label}
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
    </>
  );
}

// ---------------------------------------------------------------------------
// 5. The approval threshold
// ---------------------------------------------------------------------------

export function ThresholdForm({ options }: { readonly options: readonly FormOption[] }) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(setServiceThresholdAction, undefined);

  return (
    <>
      <Result result={result} />
      <form action={submit} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Chooser
          id="threshold-type"
          name="transactionTypeId"
          label="Service"
          placeholder="Choose a service…"
          options={options}
        />
        <Field
          label="Second approval above"
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
    </>
  );
}

// ---------------------------------------------------------------------------
// 6. Going live, and coming back out
// ---------------------------------------------------------------------------

export function ActivateForm({ options }: { readonly options: readonly FormOption[] }) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(activateAgencyProviderAction, undefined);

  return (
    <>
      <Result result={result} />
      <form action={submit} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Chooser
          id="activate-provider"
          name="providerId"
          label="Provider to make live"
          placeholder="Choose a provider…"
          options={options}
        />
        <Field
          label="Authorized under"
          name="authorizationReference"
          required
          hint="A board minute, a signed authority, a dated instruction. “Somebody switched it on” is not an authorization."
        />
        <Field label="Note" name="note" />
        <div className="sm:col-span-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'Authorizing…' : 'Make live'}
          </Button>
        </div>
      </form>
    </>
  );
}

export function DeactivateForm({ options }: { readonly options: readonly FormOption[] }) {
  const [result, submit, pending] = useActionState<
    AgencyActionResult | undefined,
    FormData
  >(deactivateAgencyProviderAction, undefined);

  return (
    <>
      <Result result={result} />
      <form action={submit} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Chooser
          id="deactivate-provider"
          name="providerId"
          label="Take out of service"
          placeholder="Choose a live provider…"
          options={options}
        />
        <div className="sm:col-span-2">
          <Field label="Because" name="reason" required />
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? 'Working…' : 'Take out of service'}
          </Button>
        </div>
      </form>
    </>
  );
}
