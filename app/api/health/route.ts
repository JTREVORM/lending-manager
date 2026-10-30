import { NextResponse } from 'next/server';

import { getAppEnvironment, getPublicEnv } from '@/lib/env.public';
import { logger } from '@/lib/logger';

/**
 * Liveness and readiness, for whatever is watching this deployment.
 *
 * ## What it says, and what it deliberately does not
 *
 * Four fields: whether the process is up, whether the data API answers, which
 * build is running, and which environment it thinks it is. Nothing else.
 *
 * A health endpoint is reachable without a session — that is the point of one
 * — so it is also the easiest thing on a deployment to probe, and anything it
 * reveals is revealed to everybody. So it does not report the database's host
 * or name, the schema version, a row count, a query time, the names of any
 * environment variables, or a reason for a failure. A monitor needs "is it
 * working"; everything else only helps somebody who should not be asking.
 *
 * ## Why the probe needs no privilege
 *
 * It calls polytos_readiness with the publishable key. The SECURITY INVOKER
 * function returns only true and reads no tables. Unlike the REST root,
 * this endpoint is explicitly available to anon and authenticated callers.
 * Readiness requires HTTP 200 and the exact boolean, not just an open port.
 *
 * The first version of this used the privileged client to count a row. That
 * worked, and it was the wrong instrument: it put the key that bypasses Row
 * Level Security into a route that exists to be called by strangers, to
 * establish something a key with no privileges can establish. The ESLint rule
 * restricting that import is what said so, and it was right.
 *
 * ## Never cached
 *
 * A cached health check reports the deployment's state at some earlier moment,
 * which is precisely when a monitor is looking for a change.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** How long to wait for the data API before calling it unreachable. */
const PROBE_TIMEOUT_MS = 4_000;

export async function GET() {
  let dataApi: 'ok' | 'unreachable' = 'unreachable';

  try {
    const env = getPublicEnv();
    const response = await fetch(
      `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/polytos_readiness`,
      {
        method: 'GET',
        redirect: 'error',
        headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY },
        cache: 'no-store',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    );

    if (response.status === 200 && (await response.json()) === true) dataApi = 'ok';
    else {
      // Recorded for the operator, never returned to the caller.
      logger.warn('The health probe received an unexpected data API response.', {
        status: response.status,
      });
    }
  } catch {
    // Do not log upstream bodies or exception messages: either could contain
    // credentials, private URLs or request details.
    logger.warn('The health probe could not verify the data API.');
  }

  const healthy = dataApi === 'ok';

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      dataApi,
      version: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0',
      environment: getAppEnvironment(),
    },
    {
      // 503 rather than 200-with-a-field, so a monitor can watch the status
      // line without parsing the body.
      status: healthy ? 200 : 503,
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    },
  );
}
