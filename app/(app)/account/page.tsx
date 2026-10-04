import Link from 'next/link';

import { OwnDetailsForm } from '@/components/auth/own-details-form';
import { UserStatusBadge } from '@/components/users/user-status-badge';
import { Card, CardHeader } from '@/components/ui/card';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { ROLES } from '@/lib/permissions';
import { PhoneValue } from '@/components/ui/data-value';

export const metadata = { title: 'My account' };

/**
 * A user's own account.
 *
 * Shows what they may see about themselves and lets them change the two
 * things that are theirs to change. Role and status are shown read-only: a
 * user should be able to see what access they have without being able to
 * grant themselves more.
 */
export default async function AccountPage() {
  const context = await guardPermission(ROUTES.account, 'account:view');

  return (
    <div className="space-y-5">
      <header>
        <h1>My account</h1>
        <p className="text-text-muted mt-1 text-sm">Your details and access.</p>
      </header>

      <Card>
        <CardHeader title="Access" description="Set by your administrator." />
        <dl className="space-y-2.5 text-sm">
          <div className="flex items-start justify-between gap-3">
            <dt className="text-text-muted">Phone (used to sign in)</dt>
            <dd className="font-medium">
              <PhoneValue value={context.phone} />
            </dd>
          </div>
          <div className="flex items-start justify-between gap-3">
            <dt className="text-text-muted">Role</dt>
            <dd className="text-right font-medium">
              {context.roles.map((role) => ROLES[role].label).join(', ')}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-3">
            <dt className="text-text-muted">Status</dt>
            <dd>
              <UserStatusBadge status={context.status} />
            </dd>
          </div>
        </dl>
        <p className="text-text-muted border-border mt-3 border-t pt-3 text-xs">
          Your role and phone number can only be changed by an administrator.
        </p>
      </Card>

      <Card>
        <CardHeader title="Your details" description="You can change these yourself." />
        <OwnDetailsForm fullName={context.fullName} email={context.email} />
      </Card>

      <Card>
        <CardHeader title="Password" />
        <p className="text-text-muted text-sm">Choose a new password at any time.</p>
        <Link
          href={ROUTES.changePassword}
          className="bg-brand-600 hover:bg-brand-700 min-h-touch mt-3 inline-flex items-center justify-center rounded-lg px-4 text-sm font-medium text-white transition-colors"
        >
          Change password
        </Link>
      </Card>
    </div>
  );
}
