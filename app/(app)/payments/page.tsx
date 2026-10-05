import { PaymentRegister } from '@/components/payments/payment-register';
import { Card } from '@/components/ui/card';
import { Money } from '@/components/ui/money';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getCompanyBranding } from '@/lib/data/company';
import { getCollectionTotals, listPayments } from '@/lib/data/payments';
import { businessToday } from '@/lib/domain/datetime';
import { toUgx } from '@/lib/domain/money';
import { PAYMENT_METHOD_LABELS } from '@/lib/domain/payment';
import { paymentSearchSchema } from '@/lib/validation/payment';

export const metadata = { title: 'Payments' };

/**
 * The payment register.
 *
 * ## Today's collections, and what is deliberately absent
 *
 * The summary shows what was *collected* today, by method, from posted
 * payments. It does not show what was *due* today alongside it, and it does
 * not name a shortfall.
 *
 * That restraint is the point. A figure labelled "outstanding today" next to a
 * collected figure invites the reader to treat the difference as arrears — and
 * arrears is a Phase 7 concept with a grace period and a penalty attached to
 * it. Showing the subtraction now would be making a judgement this phase has
 * no basis for.
 */
export default async function PaymentsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await guardPermission(ROUTES.payments, 'payments:view');
  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  // Unrecognised filter values fall back to the default rather than erroring:
  // a hand-edited query string should show the register, not a crash.
  const parsed = paymentSearchSchema.safeParse({
    query: single('query'),
    method: single('method'),
    status: single('status'),
    clientId: single('clientId'),
    from: single('from'),
    to: single('to'),
    page: single('page'),
  });

  const filter = parsed.success ? parsed.data : { page: 1 as const };

  const today = businessToday();

  const [{ payments, page, hasMore }, totals, { branding }] = await Promise.all([
    listPayments(filter),
    getCollectionTotals(today),
    getCompanyBranding(),
  ]);

  const collectedToday = totals.reduce((sum, row) => sum + row.totalAmount, 0);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title="Payments"
        description="Every payment recorded, including reversed ones."
        primaryAction={
          contextCan(context, 'payments:create') ? (
            <ActionLink href={`${ROUTES.payments}/new`}>Record a payment</ActionLink>
          ) : null
        }
      />

      {/* --- Today's collections ---------------------------------------- */}
      <section aria-labelledby="today-heading" className="min-w-0 space-y-3">
        <h2 id="today-heading" className="text-text text-lg font-semibold">
          Collected today
        </h2>

        <Card>
          <dl className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="min-w-0">
              <dt className="text-text-muted text-sm">Total</dt>
              <dd className="text-text text-xl font-semibold tabular-nums">
                <Money amount={toUgx(collectedToday)} />
              </dd>
            </div>

            {totals.map((row) => (
              <div key={row.paymentMethod} className="min-w-0">
                <dt className="text-text-muted text-sm">
                  {PAYMENT_METHOD_LABELS[row.paymentMethod]}
                </dt>
                <dd className="text-text text-xl font-semibold tabular-nums">
                  <Money amount={row.totalAmount} />
                  <span className="text-text-muted ml-1 text-sm font-normal">
                    ({row.paymentCount})
                  </span>
                </dd>
              </div>
            ))}
          </dl>

          {totals.length === 0 ? (
            <p className="text-text-muted text-sm">Nothing recorded yet today.</p>
          ) : null}
        </Card>

        <p className="text-text-muted text-sm">
          Posted payments only — a reversal removes its payment from this total. What was{' '}
          <em>due</em> today is shown on each loan; comparing the two is a later phase.
        </p>
      </section>

      {/* --- The register ----------------------------------------------- */}
      <section aria-labelledby="register-heading" className="min-w-0 space-y-3">
        <h2 id="register-heading" className="text-text text-lg font-semibold">
          Register
        </h2>

        <PaymentRegister
          payments={payments}
          page={page}
          hasMore={hasMore}
          timeZone={branding.timezone}
        />
      </section>
    </div>
  );
}
