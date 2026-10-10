'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';

/**
 * The period a collection summary covers.
 *
 * In the URL rather than in component state, so a period can be bookmarked or
 * sent to a colleague — and so the figures are computed server-side under the
 * reader's own Row Level Security rather than filtered in the browser from a
 * larger set they may not be entitled to.
 *
 * The quick ranges are the three a supervisor actually asks for. "This month"
 * is deliberately absent: read on the first of the month it shows one day and
 * reads as a fault.
 */
export function CollectionPeriodForm({
  from,
  to,
  today,
}: {
  readonly from: string;
  readonly to: string;
  readonly today: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [start, setStart] = useState(from);
  const [end, setEnd] = useState(to);

  const go = (nextFrom: string, nextTo: string): void => {
    const next = new URLSearchParams(params.toString());
    next.set('from', nextFrom);
    next.set('to', nextTo);

    startTransition(() => {
      router.replace(`${pathname}?${next.toString()}`);
    });
  };

  const back = (days: number): string => {
    const [year, month, day] = today.split('-').map(Number);
    const at = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12));
    at.setUTCDate(at.getUTCDate() - days);
    return at.toISOString().slice(0, 10);
  };

  return (
    <form
      className="min-w-0 space-y-4"
      aria-busy={isPending}
      onSubmit={(event) => {
        event.preventDefault();
        go(start, end);
      }}
      noValidate
    >
      <div className="grid min-w-0 gap-4 sm:grid-cols-3">
        <Field
          label="From"
          name="from"
          type="date"
          value={start}
          max={today}
          onChange={(event) => {
            setStart(event.target.value);
          }}
        />
        <Field
          label="To"
          name="to"
          type="date"
          value={end}
          max={today}
          onChange={(event) => {
            setEnd(event.target.value);
          }}
        />
        <div className="flex items-end">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Reading…' : 'Show the period'}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <QuickRange
          label="Today"
          onClick={() => {
            setStart(today);
            setEnd(today);
            go(today, today);
          }}
        />
        <QuickRange
          label="Last 7 days"
          onClick={() => {
            const next = back(6);
            setStart(next);
            setEnd(today);
            go(next, today);
          }}
        />
        <QuickRange
          label="Last 30 days"
          onClick={() => {
            const next = back(29);
            setStart(next);
            setEnd(today);
            go(next, today);
          }}
        />
      </div>
    </form>
  );
}

function QuickRange({
  label,
  onClick,
}: {
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-brand-700 focus-visible:outline-accent min-h-11 text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      {label}
    </button>
  );
}
