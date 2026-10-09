import Image from 'next/image';

/**
 * The company's own mark.
 *
 * ## One component, because there is one logo
 *
 * The mark appears on the sign-in screen, in the sidebar's brand block, and
 * at the head of every document the business hands to a borrower. Each of
 * those had its own glyph before — a `ShieldCheck` from the icon set — and
 * replacing three glyphs with three copies of an `<img>` is how one of them
 * ends up with the wrong aspect ratio or a missing `alt`.
 *
 * ## Why the path comes from the caller
 *
 * `company_settings.logo_path` is the source of truth, read through
 * `lib/data/company.ts`. Nothing here reaches for the database and nothing
 * hard-codes the file name: a business that replaces its logo changes one
 * row, and every surface below follows. `config/defaults.ts` holds the same
 * path for the one screen that cannot read the row — sign-in, where the
 * caller has no session.
 *
 * ## Why it degrades to a monogram rather than to nothing
 *
 * A blank space where a logo should be reads as a broken page. A company with
 * no logo recorded — which every new deployment is until somebody uploads one
 * — gets its own initials in the same tile, at the same size, so the layout
 * is identical either way.
 *
 * ## Sizes
 *
 * Four, named for where they are used rather than in pixels, so a caller
 * cannot invent a fifth that fits nothing: `nav` (the sidebar tile), `mark`
 * (the sign-in block), `document` (a receipt or statement letterhead) and
 * `hero` (the settings screen, where the business looks at its own branding).
 */
export type CompanyLogoSize = 'nav' | 'mark' | 'document' | 'hero';

/** Rendered box for each size, in CSS pixels. The asset is 1535×1024. */
const BOXES: Readonly<
  Record<CompanyLogoSize, { readonly w: number; readonly h: number }>
> = {
  nav: { w: 36, h: 36 },
  mark: { w: 56, h: 56 },
  document: { w: 64, h: 64 },
  hero: { w: 112, h: 112 },
};

const TILE: Readonly<Record<CompanyLogoSize, string>> = {
  nav: 'size-9 rounded p-0.5',
  mark: 'size-14 rounded-xl p-1.5',
  document: 'size-16 rounded-lg p-1',
  hero: 'size-28 rounded-2xl p-2',
};

const MONOGRAM_TEXT: Readonly<Record<CompanyLogoSize, string>> = {
  nav: 'text-[11px]',
  mark: 'text-base',
  document: 'text-lg',
  hero: 'text-2xl',
};

export function CompanyLogo({
  companyName,
  logoPath,
  size = 'nav',
  className,
}: {
  /** Used as the accessible name, and for the monogram fallback. */
  readonly companyName: string;
  /** `company_settings.logo_path`: a path under the public asset root. */
  readonly logoPath: string | null;
  readonly size?: CompanyLogoSize;
  readonly className?: string;
}) {
  const tile = `flex shrink-0 items-center justify-center overflow-hidden bg-white shadow-sm ${TILE[size]}${
    className === undefined ? '' : ` ${className}`
  }`;

  if (logoPath === null || logoPath.trim() === '') {
    return (
      <span aria-hidden="true" className={`${tile} text-brand-700 font-black`}>
        <span className={MONOGRAM_TEXT[size]}>{toMonogram(companyName)}</span>
      </span>
    );
  }

  const box = BOXES[size];

  return (
    <span className={tile}>
      {/*
        `next/image` rather than a bare `<img>`: the supplied asset is
        1535×1024 and 197 KB, and the sidebar renders it at 36px. The
        optimiser resizes it per use, so the brand block does not cost a
        borrower on a phone a fifth of a megabyte. The dimensions are given
        explicitly — the path is a string from the database, so there is no
        static import for Next to measure — and `object-contain` keeps the
        mark's own proportions inside a square tile.

        The path is stored without a leading slash (a CHECK on the column
        enforces that, along with no `..`), so one is added here.
      */}
      <Image
        src={`/${logoPath.replace(/^\/+/, '')}`}
        alt={companyName}
        width={box.w}
        height={box.h}
        sizes={`${String(box.w)}px`}
        className="size-full object-contain"
        priority={size === 'mark'}
      />
    </span>
  );
}

/** Up to two initials from the company's name. */
function toMonogram(companyName: string): string {
  const words = companyName
    .trim()
    .split(/\s+/)
    .filter((word) => /^[A-Za-z]/.test(word));

  if (words.length === 0) return '—';

  const first = words[0]?.[0] ?? '';
  const second = words.length > 1 ? (words[1]?.[0] ?? '') : '';
  return (first + second).toUpperCase();
}
