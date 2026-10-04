'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { REPORT_PERIODS, REPORT_PERIOD_LABELS } from '@/lib/domain/reporting';

export type ReportFilter =
  /** Period chooser plus the two date inputs a custom range needs. */
  | { readonly kind: 'period' }
  | {
      readonly kind: 'select';
      readonly name: string;
      readonly label: string;
      readonly options: readonly { readonly value: string; readonly label: string }[];
    }
  | {
      readonly kind: 'search';
      readonly name: string;
      readonly label: string;
      readonly placeholder?: string;
    };

/**
 * The filter bar above a report.
 *
 * ## Applied on submit, not on every keystroke
 *
 * A report query is not free, and a filter bar that re-runs it on each
 * character typed makes the page unusable on a slow connection — which is the
 * normal connection for this business. So there is an explicit Apply button,
 * the form submits on Enter, and `aria-live` on the result count tells a
 * screen-reader user that something changed.
 *
 * ## Why every filter is declared, never free-form
 *
 * The caller passes a list of filters with their allowed options. The values
 * end up in the query string and then in a server-side whitelist check before
 * they reach a query — so a hand-edited URL asking to filter on a column
 * nobody offered is rejected by the page, not by this component. This is the
 * labelling layer; the validation is on the server, where it has to be.
 *
 * ## Every control is labelled
 *
 * A visible `<label>` bound to each control, not a placeholder standing in for
 * one. A placeholder disappears when typing starts and is not announced as a
 * label, which leaves somebody using a screen reader with an unnamed box.
 */
export function ReportFilters({
  filters,
  resultSummary,
}: {
  readonly filters: readonly ReportFilter[];
  /** A sentence describing what is currently shown. Announced on change. */
  readonly resultSummary?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const formId = useId();

  const [draft, setDraft] = useState<Readonly<Record<string, string>>>(() => {
    const initial: Record<string, string> = {
      period: params.get('period') ?? 'today',
      from: params.get('from') ?? '',
      to: params.get('to') ?? '',
    };

    for (const filter of filters) {
      if (filter.kind === 'period') continue;
      initial[filter.name] = params.get(filter.name) ?? '';
    }

    return initial;
  });

  const set = (name: string, value: string): void => {
    setDraft((current) => ({ ...current, [name]: value }));
  };

  const apply = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const query = new URLSearchParams();

    for (const [name, value] of Object.entries(draft)) {
      if (value === '') continue;
      // The custom dates only mean anything with the custom period selected;
      // carrying them otherwise leaves a stale range in the URL that reappears
      // the next time somebody chooses Custom.
      if ((name === 'from' || name === 'to') && draft.period !== 'custom') continue;
      query.set(name, value);
    }

    router.replace(query.size === 0 ? pathname : `${pathname}?${query.toString()}`);
  };

  const hasPeriod = filters.some((filter) => filter.kind === 'period');

  return (
    <form
      onSubmit={apply}
      className="bg-surface border-border min-w-0 rounded-xl border p-4 print:hidden"
      noValidate
    >
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {hasPeriod ? (
          <>
            <div className="min-w-0">
              <Label htmlFor={`${formId}-period`}>Period</Label>
              <select
                id={`${formId}-period`}
                name="period"
                value={draft.period ?? 'today'}
                onChange={(event) => {
                  set('period', event.target.value);
                }}
                className="min-h-touch border-border-strong bg-surface text-text mt-1 w-full rounded-lg border px-3 py-2 text-base sm:text-sm"
              >
                {REPORT_PERIODS.map((period) => (
                  <option key={period} value={period}>
                    {REPORT_PERIOD_LABELS[period]}
                  </option>
                ))}
              </select>
            </div>

            {draft.period === 'custom' ? (
              <>
                <div className="min-w-0">
                  <Label htmlFor={`${formId}-from`}>From</Label>
                  <Input
                    id={`${formId}-from`}
                    name="from"
                    type="date"
                    className="mt-1"
                    value={draft.from ?? ''}
                    onChange={(event) => {
                      set('from', event.target.value);
                    }}
                  />
                </div>
                <div className="min-w-0">
                  <Label htmlFor={`${formId}-to`}>To</Label>
                  <Input
                    id={`${formId}-to`}
                    name="to"
                    type="date"
                    className="mt-1"
                    value={draft.to ?? ''}
                    onChange={(event) => {
                      set('to', event.target.value);
                    }}
                  />
                </div>
              </>
            ) : null}
          </>
        ) : null}

        {filters.map((filter) => {
          if (filter.kind === 'period') return null;

          const id = `${formId}-${filter.name}`;

          if (filter.kind === 'select') {
            return (
              <div key={filter.name} className="min-w-0">
                <Label htmlFor={id}>{filter.label}</Label>
                <select
                  id={id}
                  name={filter.name}
                  value={draft[filter.name] ?? ''}
                  onChange={(event) => {
                    set(filter.name, event.target.value);
                  }}
                  className="min-h-touch border-border-strong bg-surface text-text mt-1 w-full rounded-lg border px-3 py-2 text-base sm:text-sm"
                >
                  <option value="">All</option>
                  {filter.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            );
          }

          return (
            <div key={filter.name} className="min-w-0">
              <Label htmlFor={id}>{filter.label}</Label>
              <Input
                id={id}
                name={filter.name}
                type="search"
                className="mt-1"
                placeholder={filter.placeholder}
                value={draft[filter.name] ?? ''}
                onChange={(event) => {
                  set(filter.name, event.target.value);
                }}
              />
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-text-muted text-sm" aria-live="polite">
          {resultSummary ?? ''}
        </p>
        <Button type="submit" size="sm">
          Apply
        </Button>
      </div>
    </form>
  );
}
