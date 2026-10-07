'use client';

import { RowLink } from '@/components/ui/row-link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { UserStatusBadge } from './user-status-badge';
import { PROFILE_STATUSES } from '@/lib/domain/status';
import { ROLES, ROLE_KEYS } from '@/lib/permissions';
import type { DirectoryUser } from '@/lib/data/users';
import { PhoneValue } from '@/components/ui/data-value';

/**
 * The staff directory.
 *
 * Filters live in the URL rather than in component state, so a filtered view
 * can be shared or reloaded, and the filtering itself happens server-side —
 * which also means Row Level Security applies to the filtered query rather
 * than to a full list trimmed in the browser.
 *
 * Laid out as cards on a phone and a table from `md` up. A table at 320px
 * either scrolls sideways or crushes the columns; neither is usable at a
 * counter.
 */
export function UserDirectory({
  users,
  filter,
}: {
  readonly users: readonly DirectoryUser[];
  readonly filter: {
    readonly search: string;
    readonly role: string;
    readonly status: string;
  };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function apply(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());

    if (value === '' || value === 'all') params.delete(key);
    else params.set(key, value);

    const query = params.toString();
    startTransition(() => {
      router.replace(query === '' ? pathname : `${pathname}?${query}`);
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="user-search">Search</Label>
            <Input
              id="user-search"
              type="search"
              name="search"
              defaultValue={filter.search}
              placeholder="Name or phone number"
              onChange={(event) => apply('search', event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="user-role">Role</Label>
            <select
              id="user-role"
              value={filter.role}
              onChange={(event) => apply('role', event.target.value)}
              className="min-h-touch bg-surface text-text border-border-strong w-full rounded-lg border px-3 py-2 text-base sm:text-sm"
            >
              <option value="all">All roles</option>
              {ROLE_KEYS.map((key) => (
                <option key={key} value={key}>
                  {ROLES[key].label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="user-status">Status</Label>
            <select
              id="user-status"
              value={filter.status}
              onChange={(event) => apply('status', event.target.value)}
              className="min-h-touch bg-surface text-text border-border-strong w-full rounded-lg border px-3 py-2 text-base sm:text-sm"
            >
              <option value="all">All statuses</option>
              {PROFILE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status.charAt(0).toUpperCase() + status.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      <p aria-live="polite" className="text-text-muted text-sm">
        {pending
          ? 'Updating…'
          : `${String(users.length)} ${users.length === 1 ? 'user' : 'users'}`}
      </p>

      {users.length === 0 ? (
        <Card>
          <p className="text-text-muted text-sm">No users match these filters.</p>
        </Card>
      ) : (
        <>
          {/* Phone: one card per user. */}
          <ul className="space-y-2 md:hidden">
            {users.map((user) => (
              <li key={user.id}>
                <RowLink
                  href={`/users/${user.id}`}
                  className="record-surface hover:bg-surface-hover block rounded-lg p-4 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{user.fullName}</p>
                      <p className="text-text-muted truncate text-sm">
                        <PhoneValue value={user.phone} />
                      </p>
                    </div>
                    <UserStatusBadge status={user.status} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {user.roles.map((role) => (
                      <Badge key={role}>{ROLES[role].label}</Badge>
                    ))}
                    {user.mustChangePassword ? (
                      <Badge tone="warning">Temporary password</Badge>
                    ) : null}
                  </div>
                </RowLink>
              </li>
            ))}
          </ul>

          {/* Tablet and up: a table. */}
          <div className="hidden md:block">
            <Card className="p-0">
              <table className="w-full text-sm">
                <caption className="sr-only">Staff and client accounts</caption>
                <thead>
                  <tr className="border-border border-b text-left">
                    <th scope="col" className="t-th px-4 py-3 whitespace-nowrap">
                      Name
                    </th>
                    <th scope="col" className="t-th px-4 py-3 whitespace-nowrap">
                      Phone
                    </th>
                    <th scope="col" className="t-th px-4 py-3 whitespace-nowrap">
                      Role
                    </th>
                    <th scope="col" className="t-th px-4 py-3 whitespace-nowrap">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr
                      key={user.id}
                      className="border-border hover:bg-surface-raised border-b last:border-0"
                    >
                      <th scope="row" className="px-4 py-3 text-left font-normal">
                        <RowLink
                          href={`/users/${user.id}`}
                          className="font-medium hover:underline"
                        >
                          {user.fullName}
                        </RowLink>
                        {user.mustChangePassword ? (
                          <Badge tone="warning" className="ml-2">
                            Temporary password
                          </Badge>
                        ) : null}
                      </th>
                      <td className="text-text-muted px-4 py-3">
                        <PhoneValue value={user.phone} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          {user.roles.map((role) => (
                            <Badge key={role}>{ROLES[role].label}</Badge>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <UserStatusBadge status={user.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
