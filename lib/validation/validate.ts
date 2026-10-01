/**
 * The bridge between Zod and the application error taxonomy.
 *
 * Zod's own `ZodError` is a developer-facing structure. Everything that
 * crosses a boundary goes through here instead, so a Server Action returns a
 * `ValidationError` with field-keyed messages that a form can render, and the
 * raw Zod internals stay server-side.
 */

import type { z } from 'zod';

import { ValidationError, type FieldErrors } from '@/lib/errors';

/** Flatten Zod issues into `{ 'field.path': ['message', …] }`. */
export function toFieldErrors(error: z.ZodError): FieldErrors {
  const fields: Record<string, string[]> = {};

  for (const issue of error.issues) {
    // An issue with an empty path is a whole-object refinement; file it under
    // a reserved key so a form can still surface it.
    const key = issue.path.length === 0 ? '_form' : issue.path.join('.');
    (fields[key] ??= []).push(issue.message);
  }

  return fields;
}

/**
 * Parse `input`, throwing a `ValidationError` on failure.
 *
 * Use this where a failure is exceptional — inside a domain operation whose
 * caller has already validated, for instance.
 */
export function parseOrThrow<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  message = 'One or more fields are invalid.',
): z.output<Schema> {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new ValidationError(message, toFieldErrors(result.error));
  }

  return result.data;
}

/** The outcome of a non-throwing parse. */
export type ParseResult<Output> =
  | { readonly success: true; readonly data: Output }
  | { readonly success: false; readonly error: ValidationError };

/**
 * Parse without throwing.
 *
 * Preferred in Server Actions, where a validation failure is an ordinary
 * outcome to be returned to the form rather than an exception.
 */
export function parseSafely<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  message = 'One or more fields are invalid.',
): ParseResult<z.output<Schema>> {
  const result = schema.safeParse(input);

  if (!result.success) {
    return {
      success: false,
      error: new ValidationError(message, toFieldErrors(result.error)),
    };
  }

  return { success: true, data: result.data };
}

/**
 * Convert `FormData` to a plain object before validation.
 *
 * Repeated keys become arrays, so multi-select inputs survive. Empty strings
 * are preserved rather than coerced — the individual schema decides whether a
 * blank value means "absent" (see `optionalString`), because for some fields
 * clearing them is a deliberate act.
 *
 * `File` entries are passed through untouched for upload handling in a later
 * phase.
 */
export function formDataToObject(formData: FormData): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of formData.entries()) {
    const existing = result[key];

    if (existing === undefined) {
      result[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      result[key] = [existing, value];
    }
  }

  return result;
}
