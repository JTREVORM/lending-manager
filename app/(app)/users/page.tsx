import { UserCog } from 'lucide-react';
import { UserDirectory } from '@/components/users/user-directory';
import { Alert } from '@/components/ui/alert';
import { ActionLink, PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { contextCan } from '@/lib/auth/context';
import { listUsers } from '@/lib/data/users';
import { userDirectoryFilterSchema } from '@/lib/validation/auth';

export const metadata = { title: 'Users' };

/**
 * The staff directory.
 *
 * Guarded three times over: the proxy refuses an anonymous request, the layout
 * applies the route's `users:view` requirement, and this page states it again
 * explicitly. The third is not redundant — it is what keeps the requirement
 * visible at the surface that depends on it, and it holds even if this page is
 * later moved to a different route group.
 *
 * Underneath all of it, Row Level Security means a caller without `users:view`
 * sees only their own row no matter how they ask.
 */
export default async function UsersPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await guardPermission(ROUTES.users, 'users:view');
  const params = await searchParams;

  const parsed = userDirectoryFilterSchema.safeParse({
    search: typeof params.search === 'string' ? params.search : undefined,
    role: typeof params.role === 'string' ? params.role : 'all',
    status: typeof params.status === 'string' ? params.status : 'all',
  });

  // A malformed filter in the URL falls back to showing everything the caller
  // may see, rather than erroring: the filter is a convenience, not a control.
  const filter = parsed.success
    ? parsed.data
    : { search: undefined, role: 'all' as const, status: 'all' as const };

  const users = await listUsers(filter);
  const mayCreate = contextCan(context, 'users:create');

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Access Control"
        icon={UserCog}
        title="Users"
        description="Staff and client accounts, their roles and their access."
        primaryAction={
          mayCreate ? <ActionLink href="/users/new">Add staff member</ActionLink> : null
        }
      />

      {!mayCreate ? (
        <Alert tone="info">
          You can see staff accounts but not change them. Account administration is
          carried out by the Owner/Administrator.
        </Alert>
      ) : null}

      <UserDirectory
        users={users}
        filter={{
          search: filter.search ?? '',
          role: filter.role,
          status: filter.status,
        }}
      />
    </div>
  );
}
