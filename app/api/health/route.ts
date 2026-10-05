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
 * It asks PostgREST for its own root with the publishable key. PostgREST
 * answers there only once it has connected to PostgreSQL and built its schema
 * cache, and returns 503 when it cannot — which is exactly the question a
 * readiness probe asks. The response body is discarded.
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
    const response = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
      method: 'HEAD',
      headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY },
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (response.ok) dataApi = 'ok';
    else {
      // Recorded for the operator, never returned to the caller.
      logger.warn('The health probe reached the data API but it refused.', {
        status: response.status,
      });
    }
  } catch (error) {
    logger.warn('The health probe could not reach the data API.', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
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
