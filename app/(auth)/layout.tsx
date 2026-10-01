import type { ReactNode } from 'react';

/**
 * Layout for the unauthenticated routes.
 *
 * A separate route group from `(app)` so the sign-in page carries none of the
 * application shell: no navigation, no company chrome beyond the name, and no
 * attempt to resolve a session that does not exist.
 */
export const dynamic = 'force-dynamic';

export default function AuthLayout({ children }: { readonly children: ReactNode }) {
  return <>{children}</>;
}
