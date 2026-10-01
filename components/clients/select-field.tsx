'use client';

import { useId, type ReactNode } from 'react';

import { Label } from '@/components/ui/label';

/**
 * A labelled `select`, with the same accessibility wiring as `Field`.
 *
 * `Field` wraps an `input`, so it cannot carry a `select`. Rather than loosen
 * it into something that takes arbitrary children, this repeats the four lines
 * of plumbing — the label association, the described-by for hint and error, the
 * `role="alert"` and the `aria-invalid`. Two small correct components beat one
 * component with a `kind` prop.
 */
export function SelectField({
  label,
  name,
  options,
  defaultValue,
  hint,
  error,
  required = false,
  disabled = false,
  onValueChange,
}: {
  readonly label: string;
  readonly name: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly defaultValue?: string;
  readonly hint?: ReactNode;
  readonly error?: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  /** Notified when the choice changes, for a caller that reacts to it. */
  readonly onValueChange?: (value: string) => void;
}) {
  const generatedId = useId();
  const id = `select-${generatedId}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy = [
    hint !== undefined ? hintId : null,
    error !== undefined ? errorId : null,
  ]
    .filter((value): value is string => value !== null)
    .join(' ');

  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span aria-hidden="true" className="text-danger ml-0.5">
            *
          </span>
        ) : null}
        {required ? <span className="sr-only"> (required)</span> : null}
      </Label>

      <select
        id={id}
        name={name}
        defaultValue={defaultValue}
        required={required}
        disabled={disabled}
        onChange={
          onValueChange === undefined
            ? undefined
            : (event) => {
                onValueChange(event.target.value);
              }
        }
        aria-invalid={error !== undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        className="border-border bg-surface text-text focus-visible:outline-accent aria-invalid:border-danger h-11 w-full rounded-lg border px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {hint !== undefined ? (
        <p id={hintId} className="text-text-muted text-sm">
          {hint}
        </p>
      ) : null}

      {error !== undefined ? (
        <p id={errorId} role="alert" className="text-danger text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
