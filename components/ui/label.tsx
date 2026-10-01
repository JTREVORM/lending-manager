import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils/cn';

export interface LabelProps extends ComponentProps<'label'> {
  readonly required?: boolean;
}

/**
 * A form label.
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
      className={cn('text-text block text-sm font-medium', className)}
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
