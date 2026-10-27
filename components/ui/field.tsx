'use client';

import { useId, type ComponentProps, type ReactNode } from 'react';

import { cn } from '@/lib/utils/cn';
import { Input, type InputProps } from './input';
import { Label } from './label';

export interface FieldProps extends Omit<InputProps, 'id' | 'invalid'> {
  readonly label: string;
  /** Guidance shown below the control, e.g. an expected format. */
  readonly hint?: ReactNode;
  /** Validation message. Its presence puts the field into the error state. */
  readonly error?: string;
  readonly required?: boolean;
  /**
   * Overrides the label's colour. Needed by exactly one screen: the sign-in
   * form, whose card sits on the brand gradient, where the default
   * dark-on-light label is unreadable.
   */
  readonly labelClassName?: string;
  /** The same, for the hint line beneath the control. */
  readonly hintClassName?: string;
}

/**
 * A labelled input with its hint and error wired up for assistive technology.
 *
 * This component exists so that the accessibility plumbing is correct once
 * rather than per form:
 *
 *   - the label is associated via a generated `id`, so tapping it focuses the
 *     control and screen readers announce the two together;
 *   - the hint and the error are referenced by `aria-describedby`, so they are
 *     read out instead of being silent decoration;
 *   - the error carries `role="alert"`, so it is announced when it appears
 *     after a failed submission;
 *   - `aria-invalid` marks the control itself, not just its border colour,
 *     which is what makes the error perceivable without seeing red.
 *
 * Phase 2's forms build on this rather than reassembling it.
 */
export function Field({
  label,
  hint,
  error,
  required = false,
  labelClassName,
  hintClassName,
  ...inputProps
}: FieldProps) {
  const generatedId = useId();
  const inputId = `field-${generatedId}`;
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

      <Input
        id={inputId}
        invalid={error !== undefined}
        aria-describedby={describedBy}
        required={required}
        {...inputProps}
      />

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

/**
 * A labelled `<select>`, with the same plumbing as `Field`.
 *
 * Phase 4 needed ten of these — a claim type, a relationship, a meeting type,
 * an absence reason, a document kind, a payment method on a benefit payment —
 * and the inline markup every earlier form carries was already six lines of
 * class names that four screens had copied slightly differently. One
 * component, so the control height, the focus ring and the error wiring match
 * `Field` by construction rather than by somebody remembering.
 *
 * `placeholder` renders as a disabled empty option, so a select with no
 * sensible default starts unanswered and `required` means something. Without
 * it the first option would be silently "chosen" by the browser, which is how
 * a form ends up recording an answer nobody gave.
 */
export function SelectField({
  label,
  hint,
  error,
  required = false,
  placeholder,
  options,
  ...selectProps
}: Omit<ComponentProps<'select'>, 'id'> & {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly error?: string;
  readonly required?: boolean;
  /** The unanswered state, as a disabled empty option. */
  readonly placeholder?: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    readonly disabled?: boolean;
  }[];
}) {
  const generatedId = useId();
  const selectId = `select-${generatedId}`;
  const hintId = `${selectId}-hint`;
  const errorId = `${selectId}-error`;

  const describedBy =
    [hint !== undefined ? hintId : null, error !== undefined ? errorId : null]
      .filter((value): value is string => value !== null)
      .join(' ') || undefined;

  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={selectId} required={required}>
        {label}
      </Label>

      <select
        id={selectId}
        required={required}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy}
        className={cn(
          // The same two densities `Input` uses, from the same tokens: roomy
          // and touch-sized on a phone, the reference's compact control from
          // `md` up. A select that did not match the inputs beside it is the
          // drift this component exists to stop.
          'bg-surface text-text w-full border',
          'min-h-touch rounded-lg px-4 py-3.5 text-base',
          'md:min-h-9 md:rounded-sm md:px-2.5 md:py-1.5 md:text-[13px]',
          'transition-[color,background-color,border-color,box-shadow] duration-150',
          'focus-visible:border-accent focus-visible:[box-shadow:var(--ring-focus)] focus-visible:outline-none',
          'disabled:bg-surface-sunken disabled:text-text-muted disabled:cursor-not-allowed',
          error === undefined ? 'border-border-strong' : 'border-danger',
        )}
        {...selectProps}
      >
        {placeholder === undefined ? null : <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>

      {hint !== undefined ? (
        <p id={hintId} className="text-text-muted text-xs">
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
