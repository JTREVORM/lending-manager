import { HandCoins, PhoneCall, TriangleAlert } from 'lucide-react';

import { StatCard, StatGrid } from '@/components/reports/stat-card';
import { Money } from '@/components/ui/money';
import { RowLink } from '@/components/ui/row-link';
import { ROUTES } from '@/config/app';
import type { RecoveryWorkload } from '@/lib/data/dashboard';

/**
 * The recovery work waiting today.
 *
 * ## Why this is on the dashboard at all
 *
 * Phase 14 gave the business a recovery file: calls, visits, promises and
 * follow-up dates recorded against a loan. Everything in it was reachable only
 * by opening Debt & Security, which means the page a collections officer opens
 * first told them nothing about the promises they took last week. A promise is
 * a commitment somebody made to a person, with a date on it, and the whole
 * point of recording one is to come back to it.
 *
 * ## Three counts, and what each one is
 *
 * **Due today** is a promise whose date is today and which is still unpaid.
 * Not this week: a promise for Friday is not work for Tuesday, and a card that
 * counted it would make every day look like the busiest one.
 *
 * **Broken** is a promise whose date passed without the money arriving *by
 * then*. Paying afterwards settles the loan and does not un-break the
 * promise, which is the right rule and worth being exact about on the card:
 * the verdict is about whether the undertaking was met, not about whether the
 * debt was eventually paid. Phase 14's view derives it from the payments
 * received between the action date and the promised date, on every read — so
 * nothing marks a promise broken, nothing has to come back and clear it, and
 * the figure is right today and was right yesterday.
 *
 * **Follow-ups overdue** is the view's own judgement: a follow-up date in the
 * past with nothing recorded since. Re-deriving it here would be a second
 * opinion about the same question.
 *
 * The figure beside it is loans with *anything* on file, which is the
 * denominator those three divide. It is deliberately not the number of rows
 * the view returns: `loan_recovery_status` holds every live or cleared loan,
 * chased or not, so on the live book that would have read "26 loans in
 * recovery" against 4 with an action recorded — six times over, in the
 * direction that flatters.
 *
 * ## It links rather than lists
 *
 * The work is done on Debt & Security, where the controls to record a call or
 * take a promise sit beside each row. A dashboard that listed the rows would
 * be a worse copy of that screen, and the officer would still have to leave it
 * to do anything.
 */
export function RecoveryWorkloadCards({
  workload,
}: {
  readonly workload: RecoveryWorkload;
}) {
  return (
    <section aria-labelledby="recovery-workload-heading" className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="recovery-workload-heading" className="text-base">
          Promises and follow-ups
        </h2>
        <RowLink
          href={ROUTES.recovery}
          className="text-brand-700 text-sm font-medium underline-offset-2 hover:underline"
        >
          Open Debt &amp; Security
        </RowLink>
      </div>

      <StatGrid>
        <StatCard
          label="Promises due today"
          value={String(workload.promisesDueToday)}
          secondary="A promise for a later date is not counted here"
          definition="Loans with a promise to pay falling due today that is not yet covered. A payment arriving before the day ends makes it kept, with nothing written anywhere: the verdict is read from the posted payments each time."
          icon={HandCoins}
          tone={workload.promisesDueToday > 0 ? 'warning' : 'neutral'}
          href={ROUTES.recovery}
        />
        <StatCard
          label="Promises broken"
          value={String(workload.promisesBroken)}
          secondary={
            workload.promisesBroken === 0 ? (
              'Nothing has gone past its date unpaid'
            ) : (
              <>
                <Money amount={workload.promisedBrokenAmount} /> undertaken
              </>
            )
          }
          definition="A promise whose date passed without the money arriving by then. Paying later settles the loan but does not un-break the promise \u2014 the verdict is about whether the undertaking was met. It is derived from the posted payments on every read rather than stored, so it is right today and was right yesterday."
          icon={TriangleAlert}
          tone={workload.promisesBroken > 0 ? 'danger' : 'neutral'}
          href={ROUTES.recovery}
        />
        <StatCard
          label="Follow-ups overdue"
          value={String(workload.followUpsOverdue)}
          secondary={`${String(workload.loansInRecovery)} ${workload.loansInRecovery === 1 ? 'loan has' : 'loans have'} something on file`}
          definition="Loans whose follow-up date has passed with nothing recorded since. Recording anything against the loan clears it."
          icon={PhoneCall}
          tone={workload.followUpsOverdue > 0 ? 'warning' : 'neutral'}
          href={ROUTES.recovery}
        />
      </StatGrid>
    </section>
  );
}
