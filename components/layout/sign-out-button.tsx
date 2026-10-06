'use client';

import { LogOut } from 'lucide-react';
import { useTransition } from 'react';

import { clearServiceWorkerCaches } from '@/components/pwa/service-worker-provider';
import { signOutAction } from '@/lib/auth/actions';
import { cn } from '@/lib/utils/cn';

/**
 * Sign out.
 *
 * A form posting to a Server Action rather than a link, because signing out
 * changes state: a GET that ends a session can be triggered by any page that
 * embeds the URL as an image, which is an irritating way to be logged out.
 */
const VARIANTS = {
  /** On a light surface — the More sheet. */
  default: 'text-text-muted hover:bg-surface-raised hover:text-text',
  /** On the navy shell — the sidebar foot and the mobile header. */
  'on-dark': 'text-sidebar-muted hover:bg-white/10 hover:text-sidebar-foreground',
} as const;

export function SignOutButton({
  className,
  variant = 'default',
}: {
  readonly className?: string;
  readonly variant?: keyof typeof VARIANTS;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={() => {
        startTransition(async () => {
          // Before the session ends, not after: a shared counter browser
          // changes hands the moment the next person signs in, and the
          // caches must be gone by then. Nothing private is cached in the
          // first place — this is the floor under that claim.
          await clearServiceWorkerCaches();
          await signOutAction();
        });
      }}
    >
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending || undefined}
        className={cn(
          'min-h-touch',
          VARIANTS[variant],
          'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
      >
        <LogOut aria-hidden="true" className="size-5 shrink-0" />
        <span className="truncate">{pending ? 'Signing out' : 'Sign out'}</span>
      </button>
    </form>
  );
}
