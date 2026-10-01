import { Construction } from 'lucide-react';

import { CURRENT_PHASE } from '@/config/app';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';

export interface PhasePlaceholderProps {
  readonly title: string;
  /** The delivery phase that implements this section. */
  readonly phase: number;
  /** What this section will do, in the business's own terms. */
  readonly summary: string;
  /** The specific capabilities planned, so expectations are concrete. */
  readonly planned: readonly string[];
}

/**
 * An honest "not built yet" page.
 *
 * Phase 1 ships the foundation, not the features. Rather than showing a
 * plausible-looking empty table that implies a working screen, each unbuilt
 * section says which phase it belongs to and what it will do. Staff are never
 * left wondering whether they have broken something, and nobody mistakes a
 * placeholder for a finished feature.
 */
export function PhasePlaceholder({
  title,
  phase,
  summary,
  planned,
}: PhasePlaceholderProps) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1>{title}</h1>
        <Badge tone="info">Planned for Phase {phase}</Badge>
      </div>

      <Card>
        <div className="flex gap-3">
          <span className="bg-info-surface flex size-10 shrink-0 items-center justify-center rounded-lg">
            <Construction aria-hidden="true" className="text-info size-5" />
          </span>

          <div className="min-w-0 space-y-3">
            <div>
              <h2 className="text-base">Not available yet</h2>
              <p className="text-text-muted mt-1 text-sm">
                The system is currently at Phase {CURRENT_PHASE}, which establishes the
                database, security and application foundation. {summary}
              </p>
            </div>

            <div>
              <h3 className="text-sm font-semibold">Planned for this section</h3>
              <ul className="text-text-muted mt-1.5 list-disc space-y-1 pl-5 text-sm">
                {planned.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
