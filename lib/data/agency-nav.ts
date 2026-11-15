import 'server-only';

/**
 * The Agency branch of the navigation, read from the database.
 *
 * ## Why the rail reads the database at all
 *
 * Which banks the business uses and which agent lines are registered is
 * business data, and the client's requirements are explicit that the provider
 * and line menus must be data-driven: "Do not invent MTN or Airtel lines
 * simply to populate the menu. Do not hard-code Stanbic as the only banking
 * provider. Support future providers without restructuring application code."
 *
 * A static rail could satisfy none of that. So this reads the provider
 * register and the agent accounts the signed-in person may see, and returns
 * the plain serialisable shape `withAgencyNavData()` grafts onto the static
 * tree.
 *
 * ## Why this is cheap enough to run on every page
 *
 * Two reads, both of them small: the provider register is one row per
 * configured provider, and the account list is one row per registered agent
 * account — tens of rows, not thousands, and both are `security_invoker`
 * views so the reader's own branch rule has already narrowed them.
 *
 * The per-account *figures* are not read here. `getAgencyAgentAccounts()`
 * returns today's deposits, withdrawals, commission and pending work for each
 * account, which is several aggregates per row; the rail needs a name, a
 * status and a branch code. So this reads the registration directly and
 * leaves the aggregates to the pages that display them.
 *
 * ## Why a failure is not an error
 *
 * Returning `EMPTY_AGENCY_NAV` on any failure is deliberate. The rail is on
 * every authenticated page, and a reader with no agency capability reads
 * nothing here at all — Row Level Security sees to that, and it is the normal
 * case rather than a fault. A shell that threw because one query returned
 * nothing would take down every page in the application for a borrower.
 *
 * The static Agency operations still render for whoever may reach them; what
 * is missing is the per-bank and per-provider branches, and the empty states
 * declared on those branches say so.
 */

import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  EMPTY_AGENCY_NAV,
  type AgencyNavAccount,
  type AgencyNavData,
  type AgencyNavProvider,
} from '@/components/layout/nav-items';

/** A line status the database produced, or the safe reading of an unknown one. */
function status(value: unknown): AgencyNavAccount['status'] {
  return value === 'suspended' || value === 'closed' ? value : 'active';
}

/**
 * What to call an account in the rail.
 *
 * Its label if somebody gave it one, else the provider's own agent code, else
 * the masked number, else the till it is. Never the unmasked MSISDN: the view
 * exposes only the masked form, which is the point of exposing it that way.
 */
function accountLabel(row: {
  readonly label: unknown;
  readonly agent_code: unknown;
  readonly line_msisdn: unknown;
  readonly till_name: unknown;
}): string {
  const label = typeof row.label === 'string' ? row.label.trim() : '';
  if (label !== '') return label;

  const code = typeof row.agent_code === 'string' ? row.agent_code.trim() : '';
  if (code !== '') return code;

  const msisdn = typeof row.line_msisdn === 'string' ? row.line_msisdn : '';
  if (msisdn !== '') {
    // The same shape `mask_msisdn()` produces, applied here because this read
    // goes to the table rather than through the view. Kept in step with the
    // database's own masking on purpose: two different masks of one number
    // would be two different things to recognise it by.
    const masked = /^\+256([0-9]{2})[0-9]{6}([0-9]{4})$/.exec(msisdn);
    if (masked !== null) return `+256 ${masked[1]} *** ${masked[2]}`;
  }

  const till = typeof row.till_name === 'string' ? row.till_name : '';
  return till === '' ? 'Unnamed account' : `Till ${till}`;
}

/**
 * The banks and Mobile Money networks the rail should show, with their
 * registered accounts.
 *
 * Providers are included whether or not they hold accounts, so a bank the
 * Owner has configured and not yet staffed appears with an empty state rather
 * than being silently absent — which would look exactly like a bank that was
 * never configured.
 *
 * Inactive providers are excluded: a provider nobody may transact on is
 * configuration history, and the provider register is where it is read.
 * A *suspended* account is included, because a line that takes no new
 * business still has float, commission and a history somebody must reach.
 */
export async function getAgencyNavData(): Promise<AgencyNavData> {
  try {
    const supabase = await createSupabaseServerClient();

    const [providers, accounts] = await Promise.all([
      supabase
        .from('agency_service_providers')
        .select('id, code, name, category')
        .eq('is_active', true)
        .in('category', ['agency_banking', 'mobile_money'])
        .order('name', { ascending: true }),
      supabase
        .from('agency_provider_float_accounts')
        .select('id, provider_id, label, agent_code, line_msisdn, till_name, status')
        .order('till_name', { ascending: true }),
    ]);

    if (providers.error !== null || providers.data === null) {
      logger.warn('The Agency navigation could not read the provider register.', {
        code: providers.error?.code,
      });
      return EMPTY_AGENCY_NAV;
    }

    // The accounts read is allowed to fail on its own: a rail listing the
    // configured banks with an empty state under each is far better than no
    // Agency branch at all, and the empty state is honest about what is
    // missing.
    const accountRows = accounts.error === null ? (accounts.data ?? []) : [];
    if (accounts.error !== null) {
      logger.warn('The Agency navigation could not read the agent accounts.', {
        code: accounts.error.code,
      });
    }

    // The provider id is on the account and the code is on the provider, so
    // one lookup joins them in memory. A query per provider would be a query
    // per bank on every page in the application.
    const codeById = new Map<string, string>();
    for (const row of providers.data) {
      codeById.set(String(row.id), String(row.code));
    }

    const byCode = new Map<string, AgencyNavAccount[]>();
    for (const row of accountRows) {
      const code = codeById.get(String(row.provider_id));
      if (code === undefined) continue;
      const list = byCode.get(code) ?? [];
      list.push({
        id: String(row.id),
        label: accountLabel(row),
        status: status(row.status),
      });
      byCode.set(code, list);
    }

    const build = (category: string): readonly AgencyNavProvider[] =>
      providers.data
        .filter((p) => p.category === category)
        .map((p) => ({
          code: String(p.code),
          name: String(p.name),
          accounts: byCode.get(String(p.code)) ?? [],
        }));

    return {
      banks: build('agency_banking'),
      mobileMoney: build('mobile_money'),
    };
  } catch (error) {
    // The rail is on every authenticated page. Whatever happened here, the
    // page still has to render.
    logger.warn('The Agency navigation could not be resolved.', {
      error: error instanceof Error ? error.message : 'unknown',
    });
    return EMPTY_AGENCY_NAV;
  }
}
