'use client';

import { LogOut } from 'lucide-react';
import { useTransition, type ReactNode } from 'react';

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
  icon,
  iconOnly = false,
}: {
  readonly className?: string;
  readonly variant?: keyof typeof VARIANTS;
  /**
   * Replaces the default 20px icon. The reference's header and sidebar foot
   * use different sizes for the same control (24px in the phone icon bar,
   * 16px in the sidebar foot), so the caller supplies it.
   */
  readonly icon?: ReactNode;
  /**
   * Drops the visible label, leaving an icon-only control — what the
   * reference's header and sidebar foot render. The accessible name is kept
   * on the button either way, so the control is still announced.
   */
  readonly iconOnly?: boolean;
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
        // An icon-only control carries its name on the button itself, since
        // there is no text node left to announce.
        {...(iconOnly ? { 'aria-label': pending ? 'Signing out' : 'Sign out' } : {})}
        title={iconOnly ? 'Sign out' : undefined}
        className={cn(
          'min-h-touch',
          VARIANTS[variant],
          'flex items-center gap-3 rounded-md text-sm font-medium transition-colors',
          iconOnly ? 'justify-center' : 'w-full px-3 py-2',
          'disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
      >
        {icon ?? <LogOut aria-hidden="true" className="size-5 shrink-0" />}
        {iconOnly ? null : (
          <span className="truncate">{pending ? 'Signing out' : 'Sign out'}</span>
        )}
      </button>
    </form>
  );
}
