'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useId, useState, type ComponentProps, type ReactNode } from 'react';

import { Input } from './input';
import { Label } from './label';
import { cn } from '@/lib/utils/cn';

export interface PasswordInputProps extends Omit<ComponentProps<'input'>, 'type' | 'id'> {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly error?: string;
  readonly required?: boolean;
  /**
   * Overrides the label's colour, for the sign-in form — whose card sits on
   * the brand gradient, where the default dark-on-light label cannot be read.
   * See `Field` for the same prop and the same reason.
   */
  readonly labelClassName?: string;
  /** The same, for the hint line beneath the control. */
  readonly hintClassName?: string;
}

/**
 * A password field with a show/hide control.
 *
 * Revealing the password matters more here than on a typical site: staff type
 * long temporary passwords on phone keyboards at a counter, and without a way
 * to check what they typed they retry until the account locks or they pick
 * something shorter.
 *
 * The toggle is a real `<button>` so it is keyboard-reachable, and it carries
 * `aria-pressed` plus a label that changes with state — a screen-reader user
 * needs to know whether their password is currently on screen.
 */
export function PasswordInput({
  label,
  hint,
  error,
  required = false,
  className,
  labelClassName,
  hintClassName,
  ...inputProps
}: PasswordInputProps) {
  const [revealed, setRevealed] = useState(false);
  const generatedId = useId();

  const inputId = `password-${generatedId}`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  const describedBy =
    [hint !== undefined ? hintId : null, error !== undefined ? errorId : null]
      .filter((value): value is string => value !== null)
      .join(' ') || undefined;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId} required={required} className={labelClassName}>
        {label}
      </Label>

      <div className="relative">
        <Input
          id={inputId}
          type={revealed ? 'text' : 'password'}
          invalid={error !== undefined}
          aria-describedby={describedBy}
          required={required}
          // Right padding clears the toggle, so a long password never runs
          // underneath it.
          className={cn('pr-12', className)}
          {...inputProps}
        />

        <button
          type="button"
          onClick={() => setRevealed((current) => !current)}
          aria-pressed={revealed}
          aria-controls={inputId}
          className={cn(
            'absolute inset-y-0 right-0 flex items-center justify-center',
            // 44px wide: a toggle inside a field is still a touch target.
            'min-h-touch w-11 rounded-r-lg md:rounded-r-sm',
            'text-text-muted hover:text-text transition-colors',
          )}
        >
          {revealed ? (
            <EyeOff aria-hidden="true" className="size-4" />
          ) : (
            <Eye aria-hidden="true" className="size-4" />
          )}
          <span className="sr-only">{revealed ? 'Hide password' : 'Show password'}</span>
        </button>
      </div>

      {hint !== undefined ? (
        <p id={hintId} className={cn('text-text-muted text-xs', hintClassName)}>
          {hint}
        </p>
      ) : null}

      {error !== undefined ? (
        <p id={errorId} role="alert" className="text-danger text-xs font-medium">
          {error}
        </p>
      ) : null}
    </div>
  );
}
