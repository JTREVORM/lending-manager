'use client';

import { useId, type ReactNode } from 'react';

import { Input, type InputProps } from './input';
import { Label } from './label';

export interface FieldProps extends Omit<InputProps, 'id' | 'invalid'> {
  readonly label: string;
  /** Guidance shown below the control, e.g. an expected format. */
  readonly hint?: ReactNode;
  /** Validation message. Its presence puts the field into the error state. */
  readonly error?: string;
  readonly required?: boolean;
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
      <Label htmlFor={inputId} required={required}>
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
