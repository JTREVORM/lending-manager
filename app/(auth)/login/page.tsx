import { ShieldCheck } from 'lucide-react';

import { SignInForm } from '@/components/auth/sign-in-form';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { APP_SHORT_NAME } from '@/config/app';
import { getCompanyBranding } from '@/lib/data/company';
import { safeNextPath } from '@/lib/auth/routing';

export const metadata = { title: 'Sign in' };

/**
 * Sign-in page.
 *
 * Reachable without a session — the only route that is. The proxy sends a
 * signed-in visitor away from here, so it is never shown to someone who
 * already has a session.
 */
export const dynamic = 'force-dynamic';

/**
 * Explanations for a redirect back to sign-in.
 *
 * These are safe to show because reaching them required already holding a
 * session for the account in question. Nothing here tells an anonymous
 * visitor whether an account exists.
 */
const REASONS: Readonly<Record<string, string>> = {
  no_active_profile: 'Your account is not active. Please contact your administrator.',
  no_roles:
    'Your account has not been given a role yet. Please contact your administrator.',
};

export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { branding } = await getCompanyBranding();
  const params = await searchParams;

  const rawReason = typeof params.reason === 'string' ? params.reason : undefined;
  const reasonMessage = rawReason === undefined ? undefined : REASONS[rawReason];

  // Anything that is not a plain in-site path is discarded. A full URL here
  // would turn the lender's own sign-in page into an open redirect, which is
  // precisely what makes a phishing link convincing.
  const next = safeNextPath(typeof params.next === 'string' ? params.next : undefined);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="bg-accent mb-3 flex size-12 items-center justify-center rounded-lg [box-shadow:var(--highlight-top),var(--elevate-3)]">
            <ShieldCheck aria-hidden="true" className="text-accent-contrast size-6" />
          </span>
          {/* The company name comes from the database, never a constant, so it
              changes everywhere when registration completes. */}
          <h1 className="text-xl">{branding.companyName}</h1>
          <p className="text-text-muted mt-1 text-sm">Sign in to continue</p>
        </div>

        {reasonMessage !== undefined ? (
          <Alert tone="warning" className="mb-4">
            {reasonMessage}
          </Alert>
        ) : null}

        <Card>
          <SignInForm next={next ?? undefined} />
        </Card>

        <p className="text-text-muted mt-5 text-center text-xs">
          Forgotten your password? Your administrator can issue a new one.
        </p>
        <p className="text-text-muted mt-1 text-center text-xs">{APP_SHORT_NAME}</p>
      </div>
    </main>
  );
}
