import 'server-only';

import { unstable_rethrow } from 'next/navigation';

import { mapDatabaseError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { isClientStatus, isSex, type ClientStatus, type Sex } from '@/lib/domain/client';
import type { ClientSearchInput } from '@/lib/validation/client';

/**
 * Reading clients.
 *
 * Every query here runs as the signed-in caller through
 * `createSupabaseServerClient`, never through the privileged client. That is
 * the point: Row Level Security decides what comes back, so a borrower calling
 * `listClients` gets their own row and nothing else without this module
 * containing a single line about borrowers.
 *
 * ## Why the sensitive fields are a separate call
 *
 * `client_identities` holds the National Identification Number and the
 * identity document path, behind its own policy requiring `clients:view_nin`.
 * The list and search functions never touch that table. A Secretary/Treasurer
 * therefore cannot leak a NIN through a list view, a search, or an export —
 * not because this module is careful, but because the number is not in the
 * table it reads.
 *
 * `getClientIdentity` is the one function that reads it, and it returns null
 * rather than throwing when the policy refuses, so a caller without the
 * capability sees "not available" rather than an error page.
 */

export const CLIENTS_PAGE_SIZE = 20;

/** A client as the directory and search results show them. No NIN. */
export interface ClientSummary {
  readonly id: string;
  readonly clientNumber: string;
  readonly fullName: string;
  readonly phone: string;
  readonly villageArea: string;
  readonly district: string;
  readonly status: ClientStatus;
  readonly registeredAt: string;
  readonly hasPortalLogin: boolean;
}

/** Everything on the client record itself. Still no NIN. */
export interface ClientDetail extends ClientSummary {
  readonly sex: Sex;
  readonly dateOfBirth: string;
  readonly alternativePhone: string | null;
  readonly occupation: string;
  readonly businessType: string | null;
  readonly photoPath: string | null;
  readonly statusReason: string | null;
  readonly statusChangedAt: string | null;
  readonly notes: string | null;
  readonly profileId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The sensitive half, read only with `clients:view_nin`. */
export interface ClientIdentity {
  readonly nin: string | null;
  readonly idDocumentPath: string | null;
}

export interface ClientPage {
  readonly clients: readonly ClientSummary[];
  readonly page: number;
  readonly hasMore: boolean;
}

/** The columns the directory needs. Deliberately not `select('*')`. */
const SUMMARY_COLUMNS =
  'id, client_number, full_name, phone, village_area, district, status, registered_at, profile_id';

const DETAIL_COLUMNS = `${SUMMARY_COLUMNS}, sex, date_of_birth, alternative_phone, occupation, business_type, photo_path, status_reason, status_changed_at, notes, created_at, updated_at`;

interface SummaryRow {
  id: string;
  client_number: string;
  full_name: string;
  phone: string;
  village_area: string;
  district: string;
  status: string;
  registered_at: string;
  profile_id: string | null;
}

function toSummary(row: SummaryRow): ClientSummary {
  return {
    id: row.id,
    clientNumber: row.client_number,
    fullName: row.full_name,
    phone: row.phone,
    villageArea: row.village_area,
    district: row.district,
    // Validated rather than asserted: an unrecognised status would otherwise
    // flow into a badge lookup and render as undefined.
    status: isClientStatus(row.status) ? row.status : 'inactive',
    registeredAt: row.registered_at,
    hasPortalLogin: row.profile_id !== null,
  };
}

/**
 * Escape a user-supplied search term for a PostgREST `ilike` pattern.
 *
 * `%` and `_` are wildcards, and a comma terminates a value inside the `or()`
 * filter syntax — so an unescaped term lets a caller alter the shape of the
 * query. This is not a SQL injection (the values are still sent as parameters)
 * but it is a filter injection, and the fix is the same: escape the
 * metacharacters rather than hoping nobody types one.
 */
function escapeSearchTerm(term: string): string {
  return term.replace(/[\\%_,()]/g, (match) => `\\${match}`);
}

/**
 * The client directory, searched and filtered.
 *
 * Search covers the four identifiers the specification names: client number,
 * name, phone and NIN. The first three are matched here; **NIN is matched
 * separately** and only for callers holding `clients:view_nin`, because
 * searching a column implies being able to confirm its contents — type enough
 * digits and the result set tells you the rest of a number you could not
 * otherwise read.
 */
export async function listClients(filter: ClientSearchInput): Promise<ClientPage> {
  const supabase = await createSupabaseServerClient();

  const page = Math.max(1, filter.page);
  const from = (page - 1) * CLIENTS_PAGE_SIZE;
  // One extra row, to learn whether there is a next page without a count
  // query. A `count: 'exact'` on every keystroke is a full scan.
  const to = from + CLIENTS_PAGE_SIZE;

  let query = supabase
    .from('clients')
    .select(SUMMARY_COLUMNS)
    .order('registered_at', { ascending: false })
    .range(from, to);

  if (filter.status !== null) {
    query = query.eq('status', filter.status);
  } else {
    // The default view excludes archived records, which are retained for
    // history rather than for daily work. Selecting "Archived" explicitly
    // still shows them.
    query = query.neq('status', 'archived');
  }

  if (filter.query !== null) {
    const term = escapeSearchTerm(filter.query.trim());

    if (term !== '') {
      const matchedIds = await clientIdsMatchingNin(term);

      const clauses = [
        `client_number.ilike.%${term}%`,
        `full_name.ilike.%${term}%`,
        `phone.ilike.%${term}%`,
        `alternative_phone.ilike.%${term}%`,
      ];

      if (matchedIds.length > 0) {
        clauses.push(`id.in.(${matchedIds.join(',')})`);
      }

      query = query.or(clauses.join(','));
    }
  }

  const { data, error } = await query;

  if (error !== null) {
    logger.warn('Could not list clients.', { code: error.code });
    throw mapDatabaseError(error, 'client');
  }

  const rows = (data ?? []) as SummaryRow[];
  const hasMore = rows.length > CLIENTS_PAGE_SIZE;

  return {
    clients: rows.slice(0, CLIENTS_PAGE_SIZE).map(toSummary),
    page,
    hasMore,
  };
}

/**
 * Client ids whose NIN matches the search term.
 *
 * Returns an empty list for a caller who may not read NINs, because the policy
 * on `client_identities` filters the query to nothing. No capability check is
 * written here: the database's answer is the authority, and duplicating the
 * rule in TypeScript would create a second place for it to drift.
 *
 * A NIN search is matched as a prefix rather than a substring. A substring
 * match on identity numbers turns the search box into an oracle: enter three
 * characters, learn which clients hold a number containing them.
 */
async function clientIdsMatchingNin(term: string): Promise<readonly string[]> {
  // Nothing resembling a NIN, so no need to ask.
  if (!/^[A-Za-z0-9]{3,}$/.test(term)) return [];

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('client_identities')
    .select('client_id')
    .ilike('nin', `${term.toUpperCase()}%`)
    .limit(CLIENTS_PAGE_SIZE);

  if (error !== null) {
    // A refusal is the expected outcome for most callers. Logged at debug
    // level so it does not fill the log with non-events.
    logger.debug('NIN search returned no rows.', { code: error.code });
    return [];
  }

  return (data ?? []).map((row) => row.client_id);
}

/** One client, or null when it does not exist or the caller may not see it. */
export async function getClient(clientId: string): Promise<ClientDetail | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('clients')
    .select(DETAIL_COLUMNS)
    .eq('id', clientId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a client.', { code: error.code });
    throw mapDatabaseError(error, 'client');
  }

  if (data === null) return null;

  const row = data as SummaryRow & {
    sex: string;
    date_of_birth: string;
    alternative_phone: string | null;
    occupation: string;
    business_type: string | null;
    photo_path: string | null;
    status_reason: string | null;
    status_changed_at: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
  };

  return {
    ...toSummary(row),
    sex: isSex(row.sex) ? row.sex : 'female',
    dateOfBirth: row.date_of_birth,
    alternativePhone: row.alternative_phone,
    occupation: row.occupation,
    businessType: row.business_type,
    photoPath: row.photo_path,
    statusReason: row.status_reason,
    statusChangedAt: row.status_changed_at,
    notes: row.notes,
    profileId: row.profile_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A client's identity data, or null when the caller may not read it.
 *
 * Null rather than an error, because "you cannot see this" is a normal state
 * for a Secretary/Treasurer looking at a client page rather than an
 * exceptional one. The page shows the field as restricted.
 */
export async function getClientIdentity(
  clientId: string,
): Promise<ClientIdentity | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('client_identities')
    .select('nin, id_document_path')
    .eq('client_id', clientId)
    .maybeSingle();

  if (error !== null || data === null) return null;

  return { nin: data.nin, idDocumentPath: data.id_document_path };
}

/**
 * The client record belonging to the signed-in borrower, for the portal.
 *
 * Resolved by the policy rather than by a capability: the self-clause on
 * `clients` matches `profile_id = current_profile_id()`, so this returns
 * exactly one row for a linked borrower and nothing for anybody else. A staff
 * member calling it gets whatever their own linkage is, which is normally
 * nothing.
 */
export async function getOwnClientRecord(
  profileId: string,
): Promise<ClientDetail | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('clients')
    .select(DETAIL_COLUMNS)
    .eq('profile_id', profileId)
    .maybeSingle();

  if (error !== null) {
    unstable_rethrow(error);
    logger.warn('Could not read the caller own client record.', {
      code: error.code,
    });
    return null;
  }

  if (data === null) return null;

  return getClient(data.id);
}

// ---------------------------------------------------------------------------
// Remarks
// ---------------------------------------------------------------------------

export interface ClientRemark {
  readonly id: string;
  readonly body: string;
  readonly category: string;
  readonly authorLabel: string;
  readonly createdAt: string;
  readonly retractsRemarkId: string | null;
  /** True when a later remark withdraws this one. */
  readonly retracted: boolean;
}

/**
 * A client's remarks, newest first.
 *
 * Returns an empty list for a caller without `clients:remarks_view`, because
 * the policy filters them out. The retraction flag is computed here rather
 * than stored, so that appending a retraction does not require touching the
 * remark it withdraws — which the append-only trigger would refuse anyway.
 */
export async function listClientRemarks(
  clientId: string,
): Promise<readonly ClientRemark[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('client_remarks')
    .select('id, body, category, created_by_label, created_at, retracts_remark_id')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error !== null) {
    logger.debug('Remarks not readable by this caller.', { code: error.code });
    return [];
  }

  const rows = data ?? [];
  const retractedIds = new Set(
    rows.map((row) => row.retracts_remark_id).filter((id): id is string => id !== null),
  );

  return rows.map((row) => ({
    id: row.id,
    body: row.body,
    category: row.category,
    authorLabel: row.created_by_label,
    createdAt: row.created_at,
    retractsRemarkId: row.retracts_remark_id,
    retracted: retractedIds.has(row.id),
  }));
}
