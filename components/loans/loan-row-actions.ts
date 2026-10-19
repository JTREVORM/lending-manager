import { ROUTES } from '@/config/app';
import { isOutstanding, termsAreEditable, type LoanStatus } from '@/lib/domain/loan';
import type { RowAction } from '@/components/ui/row-actions';

/**
 * What a reader may do with a loan from the register.
 *
 * ## Every entry is a route that already exists
 *
 * Nothing here was invented because it would round out a menu. Each one is a
 * page this application already serves, reached the way the rest of the
 * interface reaches it:
 *
 *   | Entry                      | Route                           | Needs                 |
 *   |----------------------------|---------------------------------|-----------------------|
 *   | View loan details          | `/loans/{id}`                   | `loans:view`          |
 *   | View application           | `/loans/{id}/application`       | `loans:view`          |
 *   | Edit draft                 | `/loans/{id}/edit`              | `loans:update_draft`  |
 *   | View statement             | `/loans/{id}/statement`         | `loans:view`          |
 *   | Record payment             | `/payments/new?loanId={id}`     | `payments:create`     |
 *
 * The decisions — submit, approve, reject, disburse, cancel — are **not**
 * links to a one-click endpoint. They go to the loan's own page, where the
 * lifecycle panel takes them with its confirmation, its reason field, its
 * server-side validation and its audit entry. A menu item that approved a
 * loan in one click from a list would be a way around all four. So the entry
 * is worded as what it is: a way *to* the decision.
 *
 * ## Hiding is courtesy, not protection
 *
 * Each destination re-checks its own permission and Row Level Security
 * applies beneath that, so a hand-typed URL gets the same refusal. Leaving
 * an entry out only saves a staff member from pressing something that will
 * turn them away.
 *
 * ## There is no Delete
 *
 * A loan is a financial record. It is cancelled or rejected — both of which
 * are states with a reason and an audit trail — and it is never removed.
 */
export function loanRowActions({
  loanId,
  status,
  can,
}: {
  readonly loanId: string;
  readonly status: LoanStatus;
  /** The caller's own capability check, so this file holds no auth logic. */
  readonly can: (permission: string) => boolean;
}): readonly RowAction[] {
  const actions: RowAction[] = [
    { label: 'View loan details', href: `${ROUTES.loans}/${loanId}` },
    { label: 'View application', href: `${ROUTES.loans}/${loanId}/application` },
  ];

  if (termsAreEditable(status) && can('loans:update_draft')) {
    actions.push({ label: 'Edit draft', href: `${ROUTES.loans}/${loanId}/edit` });
  }

  // The decision lives on the loan's page. The wording says which decision is
  // waiting, so the menu is still useful; the panel still does the work.
  if (status === 'draft' && can('loans:submit')) {
    actions.push({
      label: 'Submit for approval',
      href: `${ROUTES.loans}/${loanId}`,
      emphasis: 'strong',
    });
  }

  if (status === 'pending_approval' && can('loans:approve')) {
    actions.push({
      label: 'Approve or reject',
      href: `${ROUTES.loans}/${loanId}`,
      emphasis: 'strong',
    });
  }

  if (status === 'approved' && can('loans:disburse')) {
    actions.push({
      label: 'Disburse loan',
      href: `${ROUTES.loans}/${loanId}`,
      emphasis: 'strong',
    });
  }

  if (isOutstanding(status) && can('payments:create')) {
    actions.push({
      label: 'Record payment',
      href: `${ROUTES.payments}/new?loanId=${loanId}`,
      emphasis: 'strong',
    });
  }

  // A statement is a document about money that moved. A draft and a pending
  // application have none, so the page would be an empty form of a receipt.
  if (status === 'active' || status === 'cleared') {
    actions.push({
      label: 'View statement',
      href: `${ROUTES.loans}/${loanId}/statement`,
    });
  }

  /*
    No "View payment history" entry.

    `/payments` takes no loan filter, so the link would open the whole
    payment register and call it this loan's history — a control that looks
    like it filters and does not. The loan's own page already embeds its
    repayment history, which is where "View loan details" goes.
  */

  return actions;
}
