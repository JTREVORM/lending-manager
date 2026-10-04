import 'server-only';

import { mapDatabaseError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { isRoleKey, type RoleKey } from '@/lib/permissions';

/**
 * Pull role keys out of an embedded PostgREST relation.
 *
 * The generated types model the relation loosely, so this validates the shape
 * rather than asserting it. An unrecognised key is dropped: a role the
 * application does not know about must not become a capability it cannot
 * reason about.
 */
function roleKeysFrom(value: unknown): readonly RoleKey[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry): unknown =>
      typeof entry === 'object' && entry !== null && 'role_key' in entry
        ? (entry as Record<string, unknown>).role_key
        : null,
    )
    .filter((key): key is RoleKey => isRoleKey(key));
}
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { ProfileStatus } from '@/lib/domain/status';
import type { UserDirectoryFilter } from '@/lib/validation/auth';

/**
 * The columns a directory row is built from, with the roles embedded.
 *
 * `user_roles!user_roles_profile_id_fkey` names the foreign key explicitly
 * because `user_roles` reaches `profiles` twice: once as the profile the role
 * belongs to, and once as `granted_by`, the profile that granted it. Left
 * unqualified, PostgREST cannot tell which relationship is meant and refuses
 * the request (PGRST201) rather than guessing — so the directory would not
 * load at all. The hint says: the holder, not the grantor.
 */
const DIRECTORY_COLUMNS =
  'id, full_name, phone, email, status, must_change_password, last_sign_in_at, created_at, auth_user_id, user_roles!user_roles_profile_id_fkey(role_key)';

/**
 * Reading the user directory.
 *
 * Every query runs as the signed-in caller, so Row Level Security decides what
 * comes back. A Secretary/Treasurer calling this sees exactly one row — their
 * own — without this module needing to know that. The filtering below is for
 * the interface's benefit, not for security.
 */

export interface DirectoryUser {
  readonly id: string;
  readonly fullName: string;
  readonly phone: string;
  readonly email: string | null;
  readonly status: ProfileStatus;
  readonly roles: readonly RoleKey[];
  readonly mustChangePassword: boolean;
  readonly lastSignInAt: string | null;
  readonly createdAt: string;
  readonly hasLogin: boolean;
}

export async function listUsers(
  filter: UserDirectoryFilter,
): Promise<readonly DirectoryUser[]> {
  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from('profiles')
    .select(DIRECTORY_COLUMNS)
    .order('full_name', { ascending: true })
    .limit(200);

  if (filter.status !== 'all') {
    query = query.eq('status', filter.status);
  }

  if (filter.search !== undefined && filter.search !== '') {
    // Escape the PostgREST pattern metacharacters so a search for "%" does not
    // become a wildcard, and so a comma cannot break out of the `or` grouping.
    const term = filter.search.replace(/[%,()]/g, '');
    if (term !== '') {
      query = query.or(`full_name.ilike.%${term}%,phone.ilike.%${term}%`);
    }
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not read the user directory.', { code: error.code });
    throw mapDatabaseError(error, 'user');
  }

  const users = (data ?? []).map((row): DirectoryUser => {
    return {
      id: row.id,
      fullName: row.full_name,
      phone: row.phone,
      email: row.email,
      status: row.status as ProfileStatus,
      roles: roleKeysFrom(row.user_roles),
      mustChangePassword: row.must_change_password,
      lastSignInAt: row.last_sign_in_at,
      createdAt: row.created_at,
      hasLogin: row.auth_user_id !== null,
    };
  });

  // Role filtering happens here rather than in the query: filtering a parent
  // by a child relationship in PostgREST excludes the other roles from the
  // result, which would make a user holding two roles appear to hold one.
  if (filter.role !== 'all') {
    return users.filter((user) => user.roles.includes(filter.role as RoleKey));
  }

  return users;
}

export async function getUser(profileId: string): Promise<DirectoryUser | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('profiles')
    .select(DIRECTORY_COLUMNS)
    .eq('id', profileId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a user record.', { code: error.code });
    throw mapDatabaseError(error, 'user');
  }

  if (data === null) return null;

  return {
    id: data.id,
    fullName: data.full_name,
    phone: data.phone,
    email: data.email,
    status: data.status as ProfileStatus,
    roles: roleKeysFrom(data.user_roles),
    mustChangePassword: data.must_change_password,
    lastSignInAt: data.last_sign_in_at,
    createdAt: data.created_at,
    hasLogin: data.auth_user_id !== null,
  };
}

/**
 * The roles the caller may grant.
 *
 * Mirrors the database rule — an administrator may not grant a role
 * outranking their own — so the picker offers only what the trigger would
 * accept. The trigger remains the authority; this exists so an administrator
 * is not offered a choice that will be refused.
 */
export async function assignableRoles(): Promise<readonly RoleKey[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.rpc('current_user_max_rank');

  if (error !== null || data === null) {
    logger.warn('Could not resolve the caller rank for role assignment.', {
      code: error?.code,
    });
    return [];
  }

  const { data: roles, error: rolesError } = await supabase
    .from('roles')
    .select('key, rank')
    .lte('rank', data)
    .order('rank', { ascending: true });

  if (rolesError !== null) return [];

  return (roles ?? [])
    .map((role) => role.key)
    .filter((key): key is RoleKey => isRoleKey(key));
}
