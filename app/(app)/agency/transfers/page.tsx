import { ArrowLeftRight } from 'lucide-react';

import { FloatTradeForm } from '@/components/agency/float-trade-forms';
import { FloatTradeRegister } from '@/components/agency/float-trade-register';
import { AgencyReadError } from '@/components/agency/read-failure';
import { Alert } from '@/components/ui/alert';
import { Card, CardHeader } from '@/components/ui/card';
import { MoneyStat } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/states';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import {
  getAgencyAgentAccounts,
  getAgencyFloatTrades,
  getAgencyProvidersByCategory,
} from '@/lib/data/agency';
import { getLedgerAccounts } from '@/lib/data/finance';
import { toUgx } from '@/lib/domain/money';

export const metadata = { title: 'Account transfers' };

type SearchParams = Record<string, string | string[] | undefined>;

function readProvider(params: SearchParams): string | null {
  const raw = params.provider;
  if (typeof raw !== 'string') return null;
  return /^[A-Z0-9_]{2,32}$/.test(raw) ? raw : null;
}

/**
 * Moving float and cash between authorised accounts.
 *
 * ## Why this screen exists
 *
 * The Phase 4E float-trade engine already had everything: a posting function
 * for a purchase, a sale and a line-to-line transfer, a maker-checker control,
 * reversal by contra entries, and a register component. What it did not have
 * was a place of its own — the form appeared only inside one provider's Mobile
 * Money screen, so a transfer between two bank agent accounts was an operation
 * the application could perform and nobody could find.
 *
 * ## Why the provider is chosen first
 *
 * Client Rule 8: "Do not assume unrelated banking providers can exchange
 * electronic float directly." They cannot, and the engine refuses it — a
 * transfer's two ends must belong to one provider, because MTN float is a
 * claim on MTN and Airtel cannot settle it. Buying and selling float is how
 * value crosses between providers, and both are recorded here as what they
 * are: a purchase against a cash account, and a sale into one.
 *
 * So the form is scoped to a provider rather than offering every account in
 * the business and refusing most of the pairs. The refusal would be correct
 * and the screen would be teaching the wrong model.
 *
 * ## Why nothing here computes a premium or a discount
 *
 * A purchase at other than face value is a premium (an expense) or a discount
 * (income), and which it is depends on the two amounts. The database decides
 * that at the moment of posting, under lock, and posts the difference to its
 * own account. A screen that worked it out would be a second opinion on a
 * figure the journal settles.
 */
export default async function AgencyTransfersPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const context = await guardPermission(ROUTES.agencyTransfers, 'agency:float_trade');
  const requested = readProvider(await searchParams);

  const [providers, trades, accounts] = await Promise.all([
    getAgencyProvidersByCategory(['agency_banking', 'mobile_money']),
    getAgencyFloatTrades({ limit: 100 }),
    getLedgerAccounts({ cashOnly: true, activeOnly: true }),
  ]);

  const header = (
    <PageHeader
      eyebrow="Agency"
      icon={ArrowLeftRight}
      title="Account transfers"
      description="Float bought, float sold, and float moved between a provider's own accounts — each checked by a second officer before it posts."
      back={{ href: ROUTES.agencyBanking, label: 'Agent Banking' }}
    />
  );

  if (!providers.ok) {
    return (
      <div className="min-w-0 space-y-4">
        {header}
        <AgencyReadError failure={providers} />
      </div>
    );
  }

  // Float-bearing providers only. A `cash_payable` provider holds no
  // electronic float, so there is nothing to trade: its position is a payable
  // and it is settled on the remittance screen instead.
  const tradeable = providers.rows.filter((p) => p.floatModel === 'provider_float');
  const provider =
    (requested === null ? undefined : tradeable.find((p) => p.code === requested)) ??
    tradeable[0];

  if (provider === undefined) {
    return (
      <div className="min-w-0 space-y-4">
        {header}
        <EmptyState
          icon={ArrowLeftRight}
          title="No provider holds electronic float yet"
          description="A transfer moves electronic float, so it needs a provider configured to hold it. A provider on the cash-payable model has no float to move — its position is a payable, settled on the provider remittances screen."
          action={{ href: ROUTES.agencyProviders, label: 'Providers & services' }}
        />
      </div>
    );
  }

  const lines = await getAgencyAgentAccounts({ providerCode: provider.code });
  const ownTrades = trades.ok
    ? trades.rows.filter((t) => t.providerCode === provider.code)
    : [];

  // The accounts a purchase may be paid from and a sale paid into: the
  // branch's own cash at hand or bank. Mapped exactly as the provider screen
  // maps them, because it is the same form and the same refusal behind it —
  // `assert_agency_settlement_account()` rejects a float account, a mobile
  // money wallet and another branch's account whatever is offered here.
  const settling = accounts
    .filter((a) => a.cashKind === 'cash_at_hand' || a.cashKind === 'bank')
    .map((a) => ({
      accountId: a.accountId,
      code: a.code,
      name: a.name,
      branchId: a.branchId,
    }));
  const pending = ownTrades.filter((t) => t.status === 'pending');

  return (
    <div className="min-w-0 space-y-4">
      {header}

      <Alert tone="info" title="What can move where">
        Float moves between two accounts of the <strong>same</strong> provider. Value
        crosses between providers by selling float into a cash account and buying it back
        on the other side, because one provider cannot settle another&rsquo;s float. Every
        movement is recorded here and posted by somebody else.
      </Alert>

      {/* Provider chips rather than a select: there are two or three of them,
          and a chip row shows which one is open without being touched. */}
      {tradeable.length > 1 ? (
        <Card>
          <CardHeader
            title="Provider"
            description="A transfer's two ends belong to one provider."
          />
          <div className="flex min-w-0 flex-wrap gap-2">
            {tradeable.map((p) => (
              <a
                key={p.code}
                href={`${ROUTES.agencyTransfers}?provider=${p.code}`}
                aria-current={p.code === provider.code ? 'page' : undefined}
                className={
                  p.code === provider.code
                    ? 'bg-brand rounded-full px-3 py-1.5 text-xs font-bold text-white'
                    : 'border-border bg-surface text-text hover:bg-surface-hover rounded-full border px-3 py-1.5 text-xs font-semibold'
                }
              >
                {p.name}
              </a>
            ))}
          </div>
        </Card>
      ) : null}

      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <MoneyStat
          label="Float held across these accounts"
          amount={toUgx(
            lines.ok ? lines.rows.reduce((s, r) => s + r.floatBalance, 0) : 0,
          )}
          note={provider.name}
        />
        <MoneyStat
          label="Awaiting a second officer"
          amount={toUgx(pending.reduce((s, t) => s + t.floatAmount, 0))}
          note={`${String(pending.length)} movement${pending.length === 1 ? '' : 's'} recorded and not yet posted`}
          tone={pending.length === 0 ? undefined : 'warning'}
        />
      </div>

      {lines.ok ? (
        <FloatTradeForm
          lines={lines.rows}
          accounts={settling}
          providerName={provider.name}
        />
      ) : (
        <AgencyReadError failure={lines} />
      )}

      <Card>
        <CardHeader
          title="Movements"
          description="Newest first. A pending movement has changed no balance; a posted one shows in the ledger."
        />
        {trades.ok ? (
          <FloatTradeRegister
            rows={ownTrades}
            canPost={contextCan(context, 'agency:settlements')}
            canReverse={contextCan(context, 'agency:reverse')}
          />
        ) : (
          <AgencyReadError failure={trades} />
        )}
      </Card>
    </div>
  );
}
