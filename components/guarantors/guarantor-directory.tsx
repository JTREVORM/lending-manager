'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatUgandanPhoneLocal } from '@/lib/domain/phone';
import type { GuarantorPage } from '@/lib/data/guarantors';

/**
 * The guarantor directory.
 *
 * Shows how many clients each person currently stands for, which is the number
 * that matters when deciding whether to accept them again — one individual
 * guaranteeing six borrowers is a concentration of risk that is invisible
 * unless it is counted here.
 *
 * No National Identification Number in the rows, for the same structural
 * reason as the client directory: it is in another table behind another
 * policy.
 */
export function GuarantorDirectory({
  page,
  query,
}: {
  readonly page: GuarantorPage;
  readonly query: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function apply(value: string): void {
    const next = new URLSearchParams(searchParams.toString());

    if (value === '') next.delete('q');
    else next.set('q', value);

    next.delete('page');

    startTransition(() => {
      router.replace(`${pathname}?${next.toString()}`);
    });
  }

  function goToPage(target: number): void {
    const next = new URLSearchParams(searchParams.toString());
    next.set('page', String(target));
    startTransition(() => {
      router.replace(`${pathname}?${next.toString()}`);
    });
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="guarantor-search">Search</Label>
          <Input
            id="guarantor-search"
            type="search"
            inputMode="search"
            defaultValue={query}
            placeholder="Name or phone number"
            onBlur={(event) => {
              apply(event.target.value.trim());
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                apply(event.currentTarget.value.trim());
              }
            }}
          />
        </div>

        <p aria-live="polite" className="text-text-muted text-sm">
          {isPending
            ? 'Searching…'
            : `${String(page.guarantors.length)} guarantor${page.guarantors.length === 1 ? '' : 's'}`}
        </p>
      </Card>

      {page.guarantors.length === 0 ? (
        <Card>
          <p className="text-text-muted">
            No guarantors match that search. Guarantors are registered from a
            client&rsquo;s page.
          </p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {page.guarantors.map((guarantor) => (
            <li key={guarantor.id}>
              <Link
                href={`/guarantors/${guarantor.id}`}
                className="border-border bg-surface focus-visible:outline-accent block rounded-xl border p-4 focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-text font-medium break-words">
                      {guarantor.fullName}
                    </p>
                    <p className="text-text-muted text-sm">
                      {formatUgandanPhoneLocal(guarantor.phone)}
                    </p>
                    <p className="text-text-muted text-sm break-words">
                      {guarantor.occupation} · {guarantor.location}
                    </p>
                  </div>

                  <p className="text-text-muted shrink-0 text-sm">
                    {guarantor.activeClientCount === 0
                      ? 'No clients'
                      : `${String(guarantor.activeClientCount)} client${guarantor.activeClientCount === 1 ? '' : 's'}`}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {(page.hasMore || page.page > 1) && (
        <nav className="flex items-center justify-between gap-3" aria-label="Pagination">
          <button
            type="button"
            disabled={page.page <= 1}
            onClick={() => {
              goToPage(page.page - 1);
            }}
            className="border-border text-text focus-visible:outline-accent min-h-11 rounded-lg border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40"
          >
            Previous
          </button>

          <span className="text-text-muted text-sm">Page {String(page.page)}</span>

          <button
            type="button"
            disabled={!page.hasMore}
            onClick={() => {
              goToPage(page.page + 1);
            }}
            className="border-border text-text focus-visible:outline-accent min-h-11 rounded-lg border px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40"
          >
            Next
          </button>
        </nav>
      )}
    </div>
  );
}
