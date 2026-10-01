import { headers } from 'next/headers';
import type { ReactNode } from 'react';

import { AppShell } from '@/components/layout/app-shell';
import { ROUTES } from '@/config/app';
import { guardPage } from '@/lib/auth/guard';
import { PATHNAME_HEADER } from '@/lib/supabase/proxy';

/**
 * Layout for the authenticated application.
 *
 * ## Never prerendered or cached
 *
 * Every page here depends on the viewer's session and role. A statically
 * generated or shared-cache response would serve one person's view to another,
 * which in a lending system means showing a client somebody else's balance.
 */
export const dynamic = 'force-dynamic';

/**
 * Every page in this group is guarded here, before any of its markup is
 * produced — so there is no flash of content a caller should not see, and no
 * page can be left unprotected by forgetting to add a check to it.
 *
 * The pathname arrives as a header set by the proxy from the framework's own
 * parsed URL; see `PATHNAME_HEADER`.
 */
export default async function AppLayout({ children }: { readonly children: ReactNode }) {
  const requestHeaders = await headers();
  const pathname = requestHeaders.get(PATHNAME_HEADER) ?? ROUTES.dashboard;

  const context = await guardPage(pathname);

  return <AppShell context={context}>{children}</AppShell>;
}
