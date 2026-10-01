import { headers } from 'next/headers';
import type { ReactNode } from 'react';

import { PortalShell } from '@/components/layout/portal-shell';
import { ROUTES } from '@/config/app';
import { guardPage } from '@/lib/auth/guard';
import { PATHNAME_HEADER } from '@/lib/supabase/proxy';

/**
 * Layout for the client portal.
 *
 * A separate route group from the staff application, with its own shell and
 * its own navigation. Keeping them apart means a borrower's pages cannot
 * accidentally inherit a staff menu, and the Phase 3 portal has somewhere to
 * grow that is structurally isolated from staff screens.
 */
export const dynamic = 'force-dynamic';

export default async function PortalLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  const requestHeaders = await headers();
  const pathname = requestHeaders.get(PATHNAME_HEADER) ?? ROUTES.portal;

  const context = await guardPage(pathname);

  return <PortalShell context={context}>{children}</PortalShell>;
}
