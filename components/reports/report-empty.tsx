import { Card } from '@/components/ui/card';

/**
 * What a report shows when it has no rows.
 *
 * Always a sentence naming *why* it is empty — no payments in this range, no
 * loans in arrears — rather than a blank table with headings. A blank table is
 * indistinguishable from a broken one, and somebody who cannot tell the
 * difference will reload the page instead of trusting the answer.
 */
export function ReportEmpty({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <Card>
      <p className="text-text font-medium">{title}</p>
      <p className="text-text-muted mt-1 text-sm">{description}</p>
    </Card>
  );
}
