import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { AUDIT_ACTION_LABELS, listAuditEntries } from '@/lib/data/audit';
import { formatInstant } from '@/lib/domain/datetime';

export const metadata = { title: 'Audit trail' };

/**
 * The audit trail.
 *
 * Read-only by construction, not by convention: the table has no UPDATE or
 * DELETE policy, those privileges are revoked from every role including
 * `service_role`, and statement-level triggers reject the attempt anyway. So
 * there is nothing to offer here beyond reading it.
 */
export default async function AuditPage() {
  await guardPermission(ROUTES.audit, 'audit:view');

  const entries = await listAuditEntries();

  return (
    <div className="space-y-5">
      <header>
        <h1>Audit trail</h1>
        <p className="text-text-muted mt-1 text-sm">
          Every change to accounts, roles and settings. Records cannot be edited or
          deleted by anyone.
        </p>
      </header>

      {entries.length === 0 ? (
        <Card>
          <p className="text-text-muted text-sm">No audit records yet.</p>
        </Card>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li key={entry.id}>
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {AUDIT_ACTION_LABELS[entry.action] ?? entry.action}
                    </p>
                    <p className="text-text-muted mt-0.5 text-sm">
                      by {entry.actorLabel}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge>{entry.entityType}</Badge>
                    <time dateTime={entry.occurredAt} className="text-text-muted text-xs">
                      {formatInstant(entry.occurredAt)}
                    </time>
                  </div>
                </div>

                {entry.newValues !== null || entry.oldValues !== null ? (
                  <details className="mt-3">
                    <summary className="text-text-muted min-h-touch flex cursor-pointer items-center text-xs">
                      What changed
                    </summary>
                    <pre className="bg-surface-raised mt-2 overflow-x-auto rounded-lg p-3 text-xs">
                      {JSON.stringify(
                        { before: entry.oldValues, after: entry.newValues },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
