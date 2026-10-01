import Link from 'next/link';
import { notFound } from 'next/navigation';

import { UserAdminPanel } from '@/components/users/user-admin-panel';
import { UserStatusBadge } from '@/components/users/user-status-badge';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { assignableRoles, getUser } from '@/lib/data/users';
import { formatInstant } from '@/lib/domain/datetime';
import { formatUgandanPhoneLocal } from '@/lib/domain/phone';
import { ROLES } from '@/lib/permissions';

export const metadata = { title: 'User' };

export default async function UserDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly profileId: string }>;
}) {
  const context = await guardPermission(ROUTES.users, 'users:view');
  const { profileId } = await params;

  const user = await getUser(profileId);

  // `null` here can mean the record does not exist or that Row Level Security
  // hid it. Both are reported as "not found", because telling a caller that a
  // record exists but is not theirs to see is itself a disclosure.
  if (user === null) notFound();

  const roles = await assignableRoles();

  return (
    <div className="space-y-5">
      <header>
        <Link href={ROUTES.users} className="text-text-muted text-sm hover:underline">
          ← Back to users
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 break-words">{user.fullName}</h1>
          <UserStatusBadge status={user.status} />
          {user.mustChangePassword ? (
            <Badge tone="warning">Temporary password in force</Badge>
          ) : null}
        </div>
      </header>

      <Card>
        <CardHeader title="Details" />
        <dl className="space-y-2.5 text-sm">
          <Row
            label="Phone (used to sign in)"
            value={formatUgandanPhoneLocal(user.phone)}
          />
          <Row label="Email" value={user.email ?? 'Not recorded'} />
          <Row
            label="Roles"
            value={
              user.roles.length === 0
                ? 'None — this account cannot sign in'
                : user.roles.map((role) => ROLES[role].label).join(', ')
            }
          />
          <Row label="Can sign in" value={user.hasLogin ? 'Yes' : 'No login created'} />
          <Row
            label="Last signed in"
            value={
              user.lastSignInAt === null ? 'Never' : formatInstant(user.lastSignInAt)
            }
          />
          <Row label="Added" value={formatInstant(user.createdAt, { withTime: false })} />
        </dl>
      </Card>

      <UserAdminPanel
        user={user}
        assignableRoles={roles}
        canAssignRole={contextCan(context, 'users:assign_role')}
        canDisable={contextCan(context, 'users:disable')}
        canResetPassword={contextCan(context, 'users:reset_password')}
        isSelf={context.profileId === user.id}
      />
    </div>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-text-muted shrink-0">{label}</dt>
      <dd className="min-w-0 text-right font-medium break-words">{value}</dd>
    </div>
  );
}
