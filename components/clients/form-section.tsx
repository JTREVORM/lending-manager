import type { ReactNode } from 'react';

/**
 * A titled group of fields inside a long form.
 *
 * A `fieldset` with a `legend` rather than a heading and a `div`, because that
 * is what tells assistive technology these controls belong together — a screen
 * reader announces the legend when focus enters the group, so "NIN" is heard as
 * "Identification, NIN" rather than as an isolated three-letter label.
 *
 * `min-w-0` on the grid children matters at 320px: a grid item defaults to
 * `min-width: auto`, so a long unbroken value (a NIN, an email) pushes the
 * whole row wider than the viewport and the page scrolls sideways.
 */
export function FormSection({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  return (
    <fieldset className="border-border bg-surface min-w-0 space-y-4 rounded-lg border p-4 shadow-xs">
      {/*
        The reference's `.form-section-title`: 13px bold behind a 4px amber
        rule. It is the one piece of colour on a long form, and it is what
        makes the sections scannable when a client record runs to six of them.

        Still a `<legend>` inside a `<fieldset>`, not a heading and a `div`,
        because that is what tells assistive technology these controls belong
        together — a screen reader announces the legend when focus enters the
        group, so "NIN" is heard as "Identification, NIN" rather than as an
        isolated three-letter label. `float-none` keeps the legend in the
        normal flow so the amber rule sits flush against the panel's padding
        rather than straddling its border.
      */}
      <legend className="form-section-title float-none mb-0">{title}</legend>

      {description !== undefined ? (
        <p className="text-text-muted -mt-1 text-[13px]">{description}</p>
      ) : null}

      <div className="grid min-w-0 gap-4 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

/** A field that should take the full width of the section grid. */
export function FullWidth({ children }: { readonly children: ReactNode }) {
  return <div className="min-w-0 sm:col-span-2">{children}</div>;
}
