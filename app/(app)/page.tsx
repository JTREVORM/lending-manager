import { Database, FileSearch, ShieldCheck, UserCog } from 'lucide-react';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { CURRENT_PHASE, ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getCompanyBranding } from '@/lib/data/company';
import { getAppEnvironment, inspectPublicEnv } from '@/lib/env.public';
import { ROLES, effectiveRole } from '@/lib/permissions';

export const metadata = { title: 'Dashboard' };

/**
 * The staff dashboard.
 *
 * Still deliberately not a metrics screen: there are no loans or payments to
 * report on, and zeroed tiles would imply a working system with no data rather
 * than a system that does not do that yet. What it does show is role-aware —
 * what this person can do, and what the foundation underneath them looks like.
 */
export default async function DashboardPage() {
  const context = await guardPermission(ROUTES.dashboard, 'dashboard:view');

  const { branding, source, fallbackReason } = await getCompanyBranding();
  const envStatus = inspectPublicEnv();
  const environment = getAppEnvironment();

  const role = effectiveRole(context.roles);
  const roleLabel = role === null ? 'No role' : ROLES[role].label;
  const mayAdministerUsers = contextCan(context, 'users:view');

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
          Signed in as {context.fullName} · {roleLabel}
        </p>
      </header>

      {!envStatus.ok ? (
        <Alert tone="warning" title="Supabase is not configured">
          <p>
            Copy <code className="font-mono text-xs">.env.example</code> to{' '}
            <code className="font-mono text-xs">.env.local</code> and fill in the values,
            then restart the server.
          </p>
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
            title="What you can do"
            description="Your role decides which sections you can open."
          />
          <ul className="space-y-1.5 text-sm">
            {context.permissions.length === 0 ? (
              <li className="text-text-muted">No capabilities assigned.</li>
            ) : (
              [...context.permissions].sort().map((permission) => (
                <li key={permission} className="flex items-center gap-2">
                  <ShieldCheck
                    aria-hidden="true"
                    className="text-brand-600 size-3.5 shrink-0"
                  />
                  <code className="font-mono text-xs">{permission}</code>
                </li>
              ))
            )}
          </ul>

          {mayAdministerUsers ? (
            <Link
              href={ROUTES.users}
              className="text-brand-700 dark:text-brand-300 mt-3 inline-flex items-center gap-1.5 text-sm font-medium hover:underline"
            >
              <UserCog aria-hidden="true" className="size-4" />
              Go to users
            </Link>
          ) : null}
        </Card>

        <Card>
          <CardHeader
            title="Company identity"
            description="Read from the database, never hard-coded."
          />
          <dl className="space-y-2.5 text-sm">
            <div className="flex items-start justify-between gap-3">
              <dt className="text-text-muted">Name</dt>
              <dd className="min-w-0 text-right font-medium break-words">
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
        </Card>
      </div>

      <Card>
        <CardHeader
          title="What is built so far"
          description="Phases 1 and 2. Lending functionality comes next."
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
              label: 'Authentication and authorization',
              detail:
                'Sign-in by phone, capability-based permissions, and Row Level Security enforcing them at the database.',
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
        <p className="text-text-muted mt-3 text-xs">
          Client registration, guarantors, loans, repayment schedules, payments, arrears,
          penalties and reporting belong to later phases.
        </p>
      </Card>
    </div>
  );
}
