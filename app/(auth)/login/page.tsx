import { BarChart3, Banknote, Receipt, ShieldCheck, Users } from 'lucide-react';

import { SignInForm } from '@/components/auth/sign-in-form';
import { Alert } from '@/components/ui/alert';
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

/**
 * What this system holds, stated beside the form.
 *
 * The reference's sign-in screen devotes its right-hand column to the
 * institution's five core values and a feedback appeal. That copy is the
 * reference company's own, so the column carries the equivalent fact about
 * this product instead — and keeps the reference's treatment exactly:
 * translucent white cards on the wash, an amber glyph, a bold 13px title over
 * a 12px line of explanation.
 *
 * Hidden below `lg`, where the form takes the full width — the reference does
 * the same, because a phone showing marketing above a password field is a
 * phone you have to scroll to sign in on.
 */
const CAPABILITIES = [
  {
    title: 'Clients',
    detail: 'Borrower records, identity documents and guarantors in one register.',
    icon: Users,
  },
  {
    title: 'Loans',
    detail: 'Products, schedules and the balance outstanding on every account.',
    icon: Banknote,
  },
  {
    title: 'Payments',
    detail: 'Collections, allocations and receipts, with every reversal traceable.',
    icon: Receipt,
  },
  {
    title: 'Reports',
    detail: 'Arrears, collections and portfolio positions, exportable.',
    icon: BarChart3,
  },
] as const;

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
    /*
      The reference's sign-in screen, which is where its whole palette comes
      from: a navy → blue → amber wash behind everything, two large blurred
      orbs for depth, and the sign-in form itself in a translucent white card
      with a backdrop blur.

      The orbs are `pointer-events-none`, so a stray click near the edge of
      the screen still lands on the page rather than on a decoration.
    */
    <main className="bg-page selection:bg-accent relative min-h-dvh overflow-hidden selection:text-white">
      {/* The brand wash, in place of the reference's photographic blur. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[#0B4394] via-[#2C5DA6] to-amber-300"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/4 -left-40 size-[28rem] rounded-full bg-amber-200/40 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-24 -right-32 size-[26rem] rounded-full bg-[#0B4394]/50 blur-3xl"
      />

      <div className="relative z-10 mx-auto flex min-h-dvh max-w-7xl flex-col justify-center px-4 py-10 sm:px-6 lg:px-10">
        {/* The institution mark: the reference's white rounded tile beside the
            name, with the system's own name tracked out beneath it. */}
        <div className="mb-8 flex items-center gap-3">
          <span className="inline-flex items-center justify-center rounded-xl bg-white/95 p-2 shadow-lg">
            <ShieldCheck aria-hidden="true" className="text-accent size-9" />
          </span>
          <div className="min-w-0">
            {/* The company name comes from the database, never a constant, so
                it changes everywhere when registration completes. */}
            <h1 className="text-lg font-black tracking-tight text-white uppercase sm:text-xl">
              {branding.companyName}
            </h1>
            <p className="text-[11px] font-semibold tracking-widest text-blue-100 uppercase">
              {APP_SHORT_NAME}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-2 lg:gap-12">
          {/* ---------------- Left: the sign-in card ---------------- */}
          <div className="w-full max-w-md">
            {reasonMessage !== undefined ? (
              <Alert tone="warning" className="mb-4 bg-amber-50">
                {reasonMessage}
              </Alert>
            ) : null}

            {/* The reference's sign-in card: translucent white over the wash,
                a bright hairline border, a heavy shadow and a backdrop blur. */}
            <div className="rounded-2xl border border-white/25 bg-white/15 p-5 shadow-2xl backdrop-blur-md sm:p-6">
              <h2 className="text-base font-bold text-white">Welcome back</h2>
              <p className="mt-0.5 text-[12px] text-blue-50">
                Sign in to continue to your workspace.
              </p>

              <div className="mt-4">
                <SignInForm next={next ?? undefined} />
              </div>
            </div>

            <p className="mt-5 text-[11px] text-white/80">
              Forgotten your password? Your administrator can issue a new one.
            </p>
          </div>

          {/* ---------------- Right: what the system is for ---------------- */}
          {/*
            The reference fills this column with its own institution's core
            values and a feedback appeal — its copy, not a design pattern, so
            what stands here instead is a plain statement of what the system
            holds. The treatment is the reference's: translucent white cards
            on the wash, in a two-column grid that collapses on a phone.
          */}
          <div className="hidden lg:block">
            <dl className="grid grid-cols-2 gap-3">
              {CAPABILITIES.map(({ title, detail, icon: Icon }) => (
                <div
                  key={title}
                  className="rounded-xl border border-white/20 bg-white/10 p-4 backdrop-blur-sm"
                >
                  <Icon aria-hidden="true" className="mb-2 size-5 text-amber-300" />
                  <dt className="text-[13px] font-bold text-white">{title}</dt>
                  <dd className="mt-0.5 text-[12px] leading-relaxed text-blue-50">
                    {detail}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>
    </main>
  );
}
