import 'server-only';

import { mapDatabaseError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { isSex, type Sex } from '@/lib/domain/client';

/**
 * Reading guarantors and their associations with clients.
 *
 * As with clients, every query runs as the caller, so the policies decide what
 * comes back. The guarantor policies have no self-clause at all: a borrower
 * reads nothing here, including the records of guarantors who vouched for
 * them. That is deliberate — a guarantor's phone number and photograph are
 * that person's data, disclosed to the lender, not to the borrower who named
 * them.
 *
 * NINs live in `guarantor_identities` behind `guarantors:view_nin`, on the
 * same reasoning as clients.
 */

export const GUARANTORS_PAGE_SIZE = 20;

export interface GuarantorSummary {
  readonly id: string;
  readonly fullName: string;
  readonly phone: string;
  readonly location: string;
  readonly occupation: string;
  readonly createdAt: string;
  /** How many clients this person currently stands for. */
  readonly activeClientCount: number;
}

export interface GuarantorDetail extends GuarantorSummary {
  readonly sex: Sex;
  readonly dateOfBirth: string;
  readonly alternativePhone: string | null;
  readonly district: string | null;
  readonly photoPath: string | null;
  readonly updatedAt: string;
}

export interface GuarantorPage {
  readonly guarantors: readonly GuarantorSummary[];
  readonly page: number;
  readonly hasMore: boolean;
}

/** An association, from either direction. */
export interface GuarantorLink {
  readonly linkId: string;
  readonly relationshipToClient: string;
  readonly createdAt: string;
  readonly active: boolean;
  readonly detachedAt: string | null;
  readonly detachedReason: string | null;
}

export interface ClientGuarantor extends GuarantorLink {
  readonly guarantorId: string;
  readonly fullName: string;
  readonly phone: string;
  readonly location: string;
  readonly occupation: string;
  readonly photoPath: string | null;
}

export interface GuarantorClient extends GuarantorLink {
  readonly clientId: string;
  readonly clientNumber: string;
  readonly fullName: string;
  readonly status: string;
}

const SUMMARY_COLUMNS = 'id, full_name, phone, location, occupation, created_at';
const DETAIL_COLUMNS = `${SUMMARY_COLUMNS}, sex, date_of_birth, alternative_phone, district, photo_path, updated_at`;

/**
 * One string field out of a loosely-typed embedded relation.
 *
 * The generated types model PostgREST's embedded relations loosely, so the
 * values arrive as `unknown`. Coercing with `String()` would turn an
 * unexpected object into the literal text `[object Object]` in the interface;
 * returning an empty string for anything that is not a string keeps a
 * surprising shape invisible rather than displayed.
 */
function textField(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  return typeof value === 'string' ? value : '';
}

/** See lib/data/clients.ts — `%`, `_` and `,` are filter metacharacters. */
function escapeSearchTerm(term: string): string {
  return term.replace(/[\\%_,()]/g, (match) => `\\${match}`);
}

/**
 * The guarantor directory.
 *
 * Searched by name and phone. NIN is matched for callers holding
 * `guarantors:view_nin`, as a prefix rather than a substring, for the same
 * reason as the client search: substring matching on an identity number turns
 * the search box into an oracle.
 */
export async function listGuarantors(filter: {
  readonly query: string | null;
  readonly page: number;
}): Promise<GuarantorPage> {
  const supabase = await createSupabaseServerClient();

  const page = Math.max(1, filter.page);
  const from = (page - 1) * GUARANTORS_PAGE_SIZE;
  const to = from + GUARANTORS_PAGE_SIZE;

  let query = supabase
    .from('guarantors')
    .select(`${SUMMARY_COLUMNS}, client_guarantors(id, active)`)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (filter.query !== null) {
    const term = escapeSearchTerm(filter.query.trim());

    if (term !== '') {
      const matchedIds = await guarantorIdsMatchingNin(term);

      const clauses = [
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
    logger.warn('Could not list guarantors.', { code: error.code });
    throw mapDatabaseError(error, 'guarantor');
  }

  const rows = data ?? [];
  const hasMore = rows.length > GUARANTORS_PAGE_SIZE;

  return {
    guarantors: rows.slice(0, GUARANTORS_PAGE_SIZE).map((row) => ({
      id: row.id,
      fullName: row.full_name,
      phone: row.phone,
      location: row.location,
      occupation: row.occupation,
      createdAt: row.created_at,
      activeClientCount: countActive(row.client_guarantors),
    })),
    page,
    hasMore,
  };
}

/** Count the active associations in an embedded PostgREST relation. */
function countActive(value: unknown): number {
  if (!Array.isArray(value)) return 0;

  return value.filter(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as Record<string, unknown>).active === true,
  ).length;
}

async function guarantorIdsMatchingNin(term: string): Promise<readonly string[]> {
  if (!/^[A-Za-z0-9]{3,}$/.test(term)) return [];

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('guarantor_identities')
    .select('guarantor_id')
    .ilike('nin', `${term.toUpperCase()}%`)
    .limit(GUARANTORS_PAGE_SIZE);

  if (error !== null) return [];

  return (data ?? []).map((row) => row.guarantor_id);
}

export async function getGuarantor(guarantorId: string): Promise<GuarantorDetail | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('guarantors')
    .select(`${DETAIL_COLUMNS}, client_guarantors(id, active)`)
    .eq('id', guarantorId)
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not read a guarantor.', { code: error.code });
    throw mapDatabaseError(error, 'guarantor');
  }

  if (data === null) return null;

  return {
    id: data.id,
    fullName: data.full_name,
    phone: data.phone,
    location: data.location,
    occupation: data.occupation,
    createdAt: data.created_at,
    activeClientCount: countActive(data.client_guarantors),
    sex: isSex(data.sex) ? data.sex : 'female',
    dateOfBirth: data.date_of_birth,
    alternativePhone: data.alternative_phone,
    district: data.district,
    photoPath: data.photo_path,
    updatedAt: data.updated_at,
  };
}

/** A guarantor's NIN, or null when the caller may not read it. */
export async function getGuarantorNin(guarantorId: string): Promise<string | null> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('guarantor_identities')
    .select('nin')
    .eq('guarantor_id', guarantorId)
    .maybeSingle();

  if (error !== null || data === null) return null;

  return data.nin;
}

/**
 * The guarantors standing for a client.
 *
 * Includes detached associations, flagged as such, because "who used to
 * guarantee this person" is part of the client's history and Phase 4 will care
 * about it.
 */
export async function listClientGuarantors(
  clientId: string,
): Promise<readonly ClientGuarantor[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('client_guarantors')
    .select(
      'id, guarantor_id, relationship_to_client, active, detached_at, detached_reason, created_at, guarantors(full_name, phone, location, occupation, photo_path)',
    )
    .eq('client_id', clientId)
    .order('active', { ascending: false })
    .order('created_at', { ascending: false });

  if (error !== null) {
    logger.debug('Guarantor associations not readable by this caller.', {
      code: error.code,
    });
    return [];
  }

  return (data ?? []).flatMap((row) => {
    const guarantor = row.guarantors as unknown;

    // The embedded relation is modelled loosely by the generated types, and a
    // missing join would otherwise render as "undefined" in the interface.
    if (typeof guarantor !== 'object' || guarantor === null) return [];

    const fields = guarantor as Record<string, unknown>;

    return [
      {
        linkId: row.id,
        guarantorId: row.guarantor_id,
        relationshipToClient: row.relationship_to_client,
        active: row.active,
        detachedAt: row.detached_at,
        detachedReason: row.detached_reason,
        createdAt: row.created_at,
        fullName: textField(fields, 'full_name'),
        phone: textField(fields, 'phone'),
        location: textField(fields, 'location'),
        occupation: textField(fields, 'occupation'),
        photoPath: typeof fields.photo_path === 'string' ? fields.photo_path : null,
      },
    ];
  });
}

/** The clients a guarantor stands for. */
export async function listGuarantorClients(
  guarantorId: string,
): Promise<readonly GuarantorClient[]> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('client_guarantors')
    .select(
      'id, client_id, relationship_to_client, active, detached_at, detached_reason, created_at, clients(client_number, full_name, status)',
    )
    .eq('guarantor_id', guarantorId)
    .order('active', { ascending: false })
    .order('created_at', { ascending: false });

  if (error !== null) return [];

  return (data ?? []).flatMap((row) => {
    const client = row.clients as unknown;

    if (typeof client !== 'object' || client === null) return [];

    const fields = client as Record<string, unknown>;

    return [
      {
        linkId: row.id,
        clientId: row.client_id,
        relationshipToClient: row.relationship_to_client,
        active: row.active,
        detachedAt: row.detached_at,
        detachedReason: row.detached_reason,
        createdAt: row.created_at,
        clientNumber: textField(fields, 'client_number'),
        fullName: textField(fields, 'full_name'),
        status: textField(fields, 'status'),
      },
    ];
  });
}
