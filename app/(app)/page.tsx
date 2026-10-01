import { Database, FileSearch, ShieldCheck } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { APP_NAME, CURRENT_PHASE } from '@/config/app';
import { getCompanyBranding } from '@/lib/data/company';
import { getAppEnvironment, inspectPublicEnv } from '@/lib/env.public';

export const metadata = { title: 'Dashboard' };

/**
 * Placeholder dashboard.
 *
 * Phase 1 has no loans, clients or payments to report on, so this page does
 * not pretend otherwise — there are no zeroed metric tiles implying a working
 * system with no data. Instead it reports on the one thing that genuinely
 * exists: the state of the foundation. That makes it useful during setup
 * (is Supabase configured? did the migrations run?) and it tells the business
 * plainly what has and has not been built.
 *
 * Phase 5 replaces this with the real operational dashboard.
 */
export default async function DashboardPage() {
  const { branding, source, fallbackReason } = await getCompanyBranding();
  const envStatus = inspectPublicEnv();
  const environment = getAppEnvironment();

  return (
    <div className="space-y-5">
      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1>Dashboard</h1>
          <Badge tone="info">Phase {CURRENT_PHASE}</Badge>
          <Badge tone={environment === 'production' ? 'warning' : 'neutral'}>
            {environment}
          </Badge>
        </div>
        <p className="text-text-muted text-sm">
          {branding.companyName} — foundation and configuration status.
        </p>
      </header>

      {!envStatus.ok ? (
        <Alert tone="warning" title="Supabase is not configured">
          <p>
            The application cannot reach the database. Copy{' '}
            <code className="font-mono text-xs">.env.example</code> to{' '}
            <code className="font-mono text-xs">.env.local</code> and fill in the values,
            then restart the development server.
          </p>
          {/* Variable names and validation messages only — never a value, so
              this is safe to render even though the page is server-side. */}
          <ul className="mt-2 list-disc space-y-0.5 pl-5">
            {envStatus.problems.map((problem) => (
              <li key={problem} className="font-mono text-xs">
                {problem}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader
            title="Company identity"
            description="Read from the database, never hard-coded in the interface."
          />
          <dl className="space-y-2.5 text-sm">
            <div className="flex items-start justify-between gap-3">
              <dt className="text-text-muted">Name</dt>
              <dd className="min-w-0 truncate text-right font-medium">
                {branding.companyName}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-text-muted">Source</dt>
              <dd className="text-right">
                <Badge tone={source === 'database' ? 'success' : 'warning'}>
                  {source === 'database' ? 'Database' : 'Configured default'}
                </Badge>
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-text-muted">Currency</dt>
              <dd className="text-right font-medium">{branding.currencyCode}</dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-text-muted">Timezone</dt>
              <dd className="text-right font-medium">{branding.timezone}</dd>
            </div>
          </dl>

          {fallbackReason !== undefined ? (
            <p className="text-text-muted border-border mt-3 border-t pt-3 text-xs">
              {fallbackReason}
            </p>
          ) : null}

          <p className="text-text-muted mt-3 text-xs">
            The company name is temporary while registration is in progress. Changing it
            is a single database update — no code change.
          </p>
        </Card>

        <Card>
          <CardHeader
            title="What Phase 1 delivers"
            description="The foundation the lending modules are built on."
          />
          <ul className="space-y-2.5 text-sm">
            {[
              {
                icon: Database,
                label: 'Database foundation',
                detail:
                  'Profiles, roles, settings, reference numbering and the audit trail, with constraints enforced in PostgreSQL.',
              },
              {
                icon: ShieldCheck,
                label: 'Security foundation',
                detail:
                  'Row Level Security enabled and default-deny on every table. Policies are defined in Phase 2.',
              },
              {
                icon: FileSearch,
                label: 'Domain foundation',
                detail:
                  'Integer shilling arithmetic, basis-point rates and Africa/Kampala date handling, all unit-tested.',
              },
            ].map(({ icon: Icon, label, detail }) => (
              <li key={label} className="flex gap-2.5">
                <Icon
                  aria-hidden="true"
                  className="text-brand-600 mt-0.5 size-4 shrink-0"
                />
                <span className="min-w-0">
                  <span className="block font-medium">{label}</span>
                  <span className="text-text-muted block text-xs">{detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Not built yet"
          description="Deliberately deferred. Each section explains what it will do."
        />
        <p className="text-text-muted text-sm">
          Client registration, guarantors, loan origination, the reducing-balance interest
          engine, repayment schedules, payment capture, arrears, penalties, the client
          portal and reporting all belong to later phases. Opening Clients, Loans,
          Payments or Settings shows what is planned for each.
        </p>
        <p className="text-text-muted mt-3 text-xs">
          {APP_NAME} · Phase {CURRENT_PHASE}
        </p>
      </Card>
    </div>
  );
}
