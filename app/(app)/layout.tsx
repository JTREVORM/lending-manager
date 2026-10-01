import type { ReactNode } from 'react';

import { AppShell } from '@/components/layout/app-shell';

/**
 * Layout for the staff-facing application.
 *
 * The `(app)` route group exists so that Phase 2 can add sign-in, sign-up and
 * the client portal as sibling groups with their own layouts, without this
 * one's navigation appearing on a public page.
 *
 * This layout does NOT check authentication. That is Phase 2, and the real
 * boundary is Row Level Security in the database regardless — a layout check
 * is a usability affordance, not a security control.
 */
/**
 * Never prerender or cache anything in the authenticated area.
 *
 * Every page here depends on the viewer's session: the shell reads
 * `company_settings` through a request-scoped Supabase client, and Phase 2
 * adds per-user and per-role data. A statically generated or shared-cache
 * response would serve one person's view to another, which in a lending
 * system means showing a client somebody else's balance.
 *
 * This also makes the rendering mode explicit rather than inferred, so adding
 * a page here cannot accidentally opt into prerendering.
 */
export const dynamic = 'force-dynamic';

export default function AppLayout({ children }: { readonly children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
