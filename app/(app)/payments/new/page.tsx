import { ArrowLeft, Receipt } from 'lucide-react';

import Link from 'next/link';

import { PaymentForm } from '@/components/payments/payment-form';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getLoan, listLoans } from '@/lib/data/loans';
import { getLoanObligations, getLoanPosition } from '@/lib/data/payments';
import { getLoanDelinquency } from '@/lib/data/delinquency';
import { mintIdempotencyKey } from '@/lib/payments/actions';
import { businessToday } from '@/lib/domain/datetime';
import { toUgx } from '@/lib/domain/money';

export const metadata = { title: 'Record a payment' };

/**
 * Recording a payment.
 *
 * ## The fast path
 *
 * This business collects many small payments, so the flow is optimised for a
 * borrower standing at the counter: search by name, client number or loan
 * number, tap the loan, and the amount field is already filled with what is
 * due. Staff never type a loan identifier.
 *
 * Only **active** loans are offered. A draft, an approved-but-undisbursed or a
 * cleared loan cannot receive a payment, and listing one would mean a staff
 * member tapping it and being refused — so they are not listed.
 *
 * ## Why the idempotency key is minted here
 *
 * Server-side, when this page renders, and carried into the form as a hidden
 * field. That is what makes a double tap safe: both submissions carry the same
 * key, and the database returns the payment that already exists. A key minted
 * at submit time would be a different key per tap and would protect nothing.
 * See ADR-030.
 */
export default async function NewPaymentPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await guardPermission(`${ROUTES.payments}/new`, 'payments:create');

  const params = await searchParams;
  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const loanId = single('loanId') ?? null;
  const query = single('query') ?? '';

  // --- A loan is chosen: show the form -----------------------------------
  if (loanId !== null) {
    const today = businessToday();

    const [position, obligations, loan, idempotencyKey, delinquency] = await Promise.all([
      getLoanPosition(loanId, today),
      getLoanObligations(loanId),
      // Fetched by id, not searched for: the register is paginated, so
      // looking the loan up in page one would silently fail to find it once
      // the business has more than a screenful of active loans.
      getLoan(loanId),
      mintIdempotencyKey(),
      getLoanDelinquency(loanId),
    ]);

    // A missing loan and an unauthorised one look the same here: both come
    // back as no position, and distinguishing them would confirm a loan
    // exists to somebody who may not see it.
    if (position === null) {
      return (
        <div className="min-w-0 space-y-4">
          <ChooseDifferentLoan />
          <Alert tone="danger">
            That loan cannot be found, or it has no repayment schedule yet. A payment can
            only be recorded against a disbursed loan.
          </Alert>
        </div>
      );
    }

    if (!position.reconciles) {
      return (
        <div className="min-w-0 space-y-4">
          <ChooseDifferentLoan />
          <Alert tone="danger">
            <span className="font-medium">
              This loan&rsquo;s ledger does not reconcile, so no payment can be recorded
              against it.
            </span>{' '}
            {position.reconciliationProblem} Report this to your administrator before
            taking any money.
          </Alert>
        </div>
      );
    }

    if (position.totalOutstanding === 0) {
      return (
        <div className="min-w-0 space-y-4">
          <ChooseDifferentLoan />
          <Alert tone="info">
            Loan {position.loanNumber} is fully repaid. There is nothing left to pay.
          </Alert>
        </div>
      );
    }

    if (position.status !== 'active') {
      return (
        <div className="min-w-0 space-y-4">
          <ChooseDifferentLoan />
          <Alert tone="warning">
            Loan {position.loanNumber} is {position.status}. A payment can only be
            recorded against an active loan.
          </Alert>
        </div>
      );
    }

    return (
      <div className="min-w-0 space-y-4">
        <PageHeader
          eyebrow="Collections"
          icon={Receipt}
          back={{ href: `${ROUTES.payments}/new`, label: 'Choose a different loan' }}
          title="Record a payment"
          description="Check the amount against what the borrower hands over. Only the Owner can reverse a payment once it is recorded."
        />

        <PaymentForm
          loanId={loanId}
          loanNumber={position.loanNumber}
          clientName={loan?.clientName ?? ''}
          clientNumber={loan?.clientNumber ?? ''}
          obligations={obligations}
          outstanding={position.totalOutstanding}
          unpaidDue={position.unpaidScheduledDue}
          minimumPayment={position.minimumPayment}
          idempotencyKey={idempotencyKey}
          /* Phase 7. The itemised demand, so the figure the staff member asks
             for is the one the screen justifies: previous unpaid, today, and
             the total. A pending penalty is flagged here because posting will
             materialise it, which changes the balance the receipt shows. */
          delinquency={
            delinquency === null
              ? undefined
              : {
                  arrears: delinquency.arrearsAmount,
                  dueToday: delinquency.dueToday,
                  currentDue: delinquency.currentDue,
                  contractualOutstanding: delinquency.contractualOutstanding,
                  penaltyRemaining: delinquency.penaltyRemaining,
                  penaltyEligible: delinquency.penaltyEligible,
                  penaltyProjectedAmount: delinquency.penaltyProjectedAmount,
                  state: delinquency.state,
                }
          }
        />
      </div>
    );
  }

  // --- No loan yet: choose one -------------------------------------------
  const { loans } = await listLoans({
    query: query === '' ? null : query,
    status: 'active',
    clientId: null,
    page: 1,
  });

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        eyebrow="Collections"
        icon={Receipt}
        back={{ href: ROUTES.payments, label: 'Payments' }}
        title="Record a payment"
        description="Find the borrower, then choose their loan."
      />

      <Card>
        <form method="get" className="flex min-w-0 flex-wrap gap-2">
          <div className="min-w-0 grow">
            <label htmlFor="loan-search" className="sr-only">
              Search by borrower name, client number or loan number
            </label>
            <Input
              id="loan-search"
              name="query"
              type="search"
              placeholder="Name, client number or loan number"
              defaultValue={query}
              autoFocus
            />
          </div>
          <button
            type="submit"
            className="bg-accent text-accent-contrast focus-visible:outline-accent inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Search
          </button>
        </form>
      </Card>

      {loans.length === 0 ? (
        <Card>
          <p className="text-text-muted text-sm">
            No active loan matches. Only active loans can receive a payment — a loan that
            is still awaiting approval or disbursement, or one already settled, will not
            appear here.
          </p>
        </Card>
      ) : (
        <ul className="min-w-0 space-y-2">
          {loans.map((loan) => (
            <li key={loan.id} className="min-w-0">
              <Link
                href={`${ROUTES.payments}/new?loanId=${loan.id}`}
                className="border-border bg-surface focus-visible:outline-accent block min-w-0 rounded-lg border p-3 focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-text font-medium break-words">
                    {loan.clientName}
                  </span>
                  <span className="text-text-muted tabular-nums">
                    <Money amount={toUgx(loan.totalExpectedRepayment)} /> contract
                  </span>
                </div>
                <div className="text-text-muted mt-1 flex flex-wrap gap-x-3 text-xs">
                  <span className="font-mono">{loan.clientNumber}</span>
                  <span className="font-mono">{loan.loanNumber}</span>
                  <span>{loan.repaymentFrequency.replace(/_/g, ' ')}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Back to the loan chooser.
 *
 * The four short "this loan cannot take a payment" panels on this page are
 * not full screens and carry no banner, so they keep a plain back link — the
 * same text link `PageHeader` renders above its banner, so the two read
 * identically wherever the reader meets them.
 */
function ChooseDifferentLoan() {
  return (
    <Link
      href={`${ROUTES.payments}/new`}
      className="text-text-muted hover:text-accent inline-flex min-h-8 items-center gap-1.5 text-xs font-medium"
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      Choose a different loan
    </Link>
  );
}
