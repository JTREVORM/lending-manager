'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { PasswordInput } from '@/components/ui/password-input';
import { signInAction, type ActionResult } from '@/lib/auth/actions';

/**
 * The sign-in form.
 *
 * On success the action redirects, so there is no success state to render
 * here — only failure. Every failure shows the same sentence, whatever caused
 * it; see `lib/auth/actions.ts` for why that matters.
 */
export function SignInForm({ next }: { readonly next?: string }) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    signInAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {/* Where the visitor was heading before being asked to sign in. Already
          sanitised server-side, and sanitised again in the action — a hidden
          field is client-supplied input like any other. */}
      {next !== undefined ? <input type="hidden" name="next" value={next} /> : null}
      {state?.ok === false && state.message !== undefined ? (
        <Alert tone="danger">{state.message}</Alert>
      ) : null}

      <Field
        label="Phone number"
        name="identifier"
        type="tel"
        inputMode="tel"
        // Browsers offer the saved username for this token; `tel` keeps the
        // numeric keypad on a phone.
        autoComplete="username"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        required
        hint="For example 0772 123 456"
        error={state?.fieldErrors?.identifier?.[0]}
        disabled={pending}
      />

      <PasswordInput
        label="Password"
        name="password"
        autoComplete="current-password"
        required
        error={state?.fieldErrors?.password?.[0]}
        disabled={pending}
      />

      <Button type="submit" size="lg" loading={pending} className="w-full">
        {pending ? 'Signing in' : 'Sign in'}
      </Button>
    </form>
  );
}
