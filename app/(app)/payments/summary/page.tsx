import { ChartColumn } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { CollectionSummaryView } from '@/components/payments/collection-summary-view';
import { CollectionPeriodForm } from '@/components/payments/collection-period-form';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getCollectionSummary } from '@/lib/data/collections';
import { getCompanyBranding } from '@/lib/data/company';
import { businessToday, isBusinessDate, type BusinessDate } from '@/lib/domain/datetime';

export const metadata = { title: 'Collection summary' };

/** How far back the default period reaches. A month is the shift a supervisor reviews. */
const DEFAULT_SPAN_DAYS = 29;

/**
 * The Collection Summary.
 *
 * ## Why the period defaults to the last thirty days
 *
 * Not to today: a summary that opens on a single day's collections is the
 * figure `/payments` already shows at the top of the register, and a screen
 * whose five tables each have one row is a screen nobody will open twice. Not
 * to the month either — a month-to-date summary read on the first of the month
 * is almost empty, which reads as a fault rather than as a date range.
 *
 * ## Every figure comes from one read
 *
 * `getCollectionSummary` reads the register once and sums it five ways, so the
 * method totals, the staff totals and the daily totals are partitions of the
 * same rows and cannot disagree. It also reports whether it saw the whole
 * period, and the view refuses to be trusted when it did not — an understated
 * summary that looks complete is the one failure mode that matters on a screen
 * somebody banks from.
 */
export default async function CollectionSummaryPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await guardPermission(`${ROUTES.payments}/summary`, 'payments:view');

  const params = await searchParams;

  const single = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const { branding } = await getCompanyBranding();
  const today = businessToday(new Date(), branding.timezone);

  const rawFrom = single('from');
  const rawTo = single('to');

  const to: BusinessDate = rawTo !== undefined && isBusinessDate(rawTo) ? rawTo : today;

  const from: BusinessDate =
    rawFrom !== undefined && isBusinessDate(rawFrom)
      ? rawFrom
      : shiftDays(to, -DEFAULT_SPAN_DAYS);

  // A reversed range reads as an empty summary, which looks like "nothing was
  // collected" rather than "those dates are the wrong way round". Swapping is
  // what the person meant.
  const [start, end] = from <= to ? [from, to] : [to, from];

  const summary = await getCollectionSummary(start, end);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Collections"
        icon={ChartColumn}
        back={{ href: ROUTES.payments, label: 'Payments' }}
        title="Collection summary"
        description="What came in over a period, by method, staff member, branch, product and day."
      />

      <Card className="min-w-0">
        <CollectionPeriodForm from={start} to={end} today={today} />
      </Card>

      <CollectionSummaryView summary={summary} />
    </div>
  );
}

/**
 * A business date shifted by whole days.
 *
 * Built from the date parts rather than from a timestamp, so it cannot drift
 * across a timezone boundary: `YYYY-MM-DD` at noon UTC is the same calendar
 * day in Kampala however the arithmetic rounds.
 */
function shiftDays(date: BusinessDate, days: number): BusinessDate {
  const [year, month, day] = date.split('-').map(Number);
  const at = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12));
  at.setUTCDate(at.getUTCDate() + days);

  const shifted = at.toISOString().slice(0, 10);

  // `isBusinessDate` is the only thing that may mint the branded type, and
  // arithmetic that produced something it rejects is a bug worth seeing.
  return isBusinessDate(shifted) ? shifted : date;
}
