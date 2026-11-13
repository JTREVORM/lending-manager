import { Alert } from '@/components/ui/alert';
import type { AgencyReadFailure } from '@/lib/data/agency';

/**
 * What a screen shows when a financial read did not happen.
 *
 * Not a nicety. Before this existed, every reader in `lib/data/agency.ts`
 * answered a failure with an empty list, so a screen rendered "Nothing
 * outstanding", "No exceptions" or `UGX 0` — three statements about the
 * business, produced by a query that never ran. An officer closing a day on
 * "no exceptions" has been told something, and it was not true.
 *
 * So the rule here is: say what could not be read, say what that does *not*
 * mean, and offer no figure at all. A panel that said "could not load" and
 * still showed a zero beside it would be the same defect with an apology
 * attached.
 */
export function AgencyReadError({ failure }: { readonly failure: AgencyReadFailure }) {
  return (
    <Alert tone={failure.kind === 'forbidden' ? 'warning' : 'danger'}>
      {failure.kind === 'forbidden' ? (
        <>
          <strong>You may not read {failure.what}.</strong> The database refused this
          request, so what is missing below was never read &mdash; it is not a zero and
          not an empty list. Ask an Owner if you believe you should see it.
        </>
      ) : (
        <>
          <strong>{sentenceCase(failure.what)} could not be read.</strong> This is not a
          zero and not an empty register: the figures were not retrieved. Reload in a
          moment, and do not record a decision on what this screen is not showing.
        </>
      )}
    </Alert>
  );
}

/** "the float and till balances" → "The float and till balances". */
function sentenceCase(what: string): string {
  return what.charAt(0).toUpperCase() + what.slice(1);
}
