import { Download, FileText, Scale } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { PageHeader, ActionLink } from '@/components/ui/page-header';
import { PrintButton } from '@/components/reports/print-button';
import { TrialBalance } from '@/components/finance/trial-balance';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getCompanyBranding } from '@/lib/data/company';
import { getTrialBalance } from '@/lib/data/finance';
import { businessToday, formatBusinessDate } from '@/lib/domain/datetime';

export const metadata = { title: 'Trial balance' };

/**
 * The trial balance.
 *
 * ## One source of truth, and it is `public.trial_balance`
 *
 * The view groups `journal_lines` by account and returns each account's debit
 * total and credit total. This page reads it, arranges it, and foots it.
 * Nothing here sums journal lines, recomputes a balance, or asks the database
 * a second question about the same figures — the whole point of the business
 * having a ledger is that a balance is an accounting fact with one answer.
 *
 * ## Why there is no date filter and no branch filter
 *
 * Because the view has neither, and inventing them would mean a second query
 * over the same journal lines — a second source of truth for figures that
 * already have one, which is the failure this page exists to avoid.
 *
 * Neither omission is an oversight; both are the ledger's own design:
 *
 *   - **Date.** `trial_balance` has no date dimension. An as-of statement
 *     would need the view to grow one (a `trial_balance_as_of(date)`
 *     alongside the existing `ledger_account_balance_as_of`), which is a
 *     database change rather than a screen. Until it does, this is the
 *     position *now*, and it says so.
 *   - **Branch.** The chart deliberately does not branch income and expense
 *     accounts — `20261010000100_branches_and_ledger.sql` says why: a
 *     per-branch "Interest Income — Nansana" would be "a reporting dimension
 *     pretending to be an account". Branch is carried by the journal entry,
 *     and a trial balance is a statement of the whole entity. Per-branch
 *     figures live where they belong: the cash position, the collection
 *     summary's by-branch slice and the aging report.
 *
 * A control that looked like a filter and narrowed nothing would be worse
 * than no control.
 *
 * ## Branch visibility and capabilities are the view's, not this page's
 *
 * `trial_balance` is declared `security_invoker = true`, so it runs as the
 * caller: Row Level Security on `journal_lines` and `ledger_accounts` decides
 * which postings are counted. Two people with different visibility open this
 * screen and get two statements, each footing on its own rows, without this
 * page containing a single branch or role condition.
 *
 * ## Read-only, structurally
 *
 * There is no form, no action and no mutation path on this route. A
 * correction to the books is a journal entry, made where journal entries are
 * made; a statement that could be edited would not be a statement.
 */
export default async function TrialBalancePage() {
  await guardPermission(ROUTES.trialBalance, 'ledger:view');

  const [summary, { branding }] = await Promise.all([
    getTrialBalance(),
    getCompanyBranding(),
  ]);

  const asAt = formatBusinessDate(businessToday(new Date(), branding.timezone));

  return (
    <div className="min-w-0 space-y-5">
      <PageHeader
        eyebrow="Financial Ledger"
        icon={Scale}
        back={{ href: ROUTES.finance, label: 'Finance' }}
        title="Trial balance"
        description={
          <>
            Every posting to date · {asAt} · {branding.companyName}
            <span className="mt-1.5 block">
              Read from the ledger. Debits and credits foot to the same figure when the
              books are sound.
            </span>
          </>
        }
        secondaryActions={
          <>
            <PrintButton />
            {/*
              `prefetch={false}` on both: these hrefs are file downloads, and
              prefetching one would run the statement — and build the PDF — on
              hover. The same reason `ExportActions` gives for every report.
            */}
            <ActionLink
              href={`${ROUTES.trialBalance}/export?format=pdf`}
              prefetch={false}
              variant="secondary"
              className="print:hidden"
            >
              <FileText aria-hidden="true" className="size-4" />
              Download PDF
            </ActionLink>
            <ActionLink
              href={`${ROUTES.trialBalance}/export`}
              prefetch={false}
              variant="secondary"
              className="print:hidden"
            >
              <Download aria-hidden="true" className="size-4" />
              Download CSV
            </ActionLink>
          </>
        }
      />

      {summary === null ? (
        <Alert tone="warning" title="The trial balance could not be read">
          The figures are derived from the ledger, so nothing is lost — reload in a
          moment. A statement is not shown rather than shown empty: two zero totals would
          read as books that are empty and balanced.
        </Alert>
      ) : (
        <TrialBalance summary={summary} />
      )}
    </div>
  );
}
