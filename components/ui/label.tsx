import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

export interface LabelProps extends ComponentProps<'label'> {
  readonly required?: boolean;
}

/**
 * A form label.
 *
 * The reference's `.form-label`: 16px at weight 400 on a phone, dropping to
 * 12px at weight 500 and a slate-700 grey on the desktop, where it sits above
 * a compact field in a dense filter row.
 *
 * `htmlFor` is required by the type, because a label that is not associated
 * with a control is decoration: it does not enlarge the hit area and it is not
 * announced when the field is focused.
 */
export function Label({
  className,
  required = false,
  children,
  htmlFor,
  ...props
}: LabelProps & { readonly htmlFor: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn(
        'text-text block text-base font-normal',
        'md:text-brand-700 md:text-xs md:font-medium',
        className,
      )}
      {...props}
    >
      {children}
      {required ? (
        <>
          <span aria-hidden="true" className="text-danger ml-0.5">
            *
          </span>
          <span className="sr-only"> (required)</span>
        </>
      ) : null}
    </label>
  );
}
