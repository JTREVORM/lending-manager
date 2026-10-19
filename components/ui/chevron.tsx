/**
 * The chevrons, inline.
 *
 * Six of them appeared with the register redesign — a breadcrumb separator,
 * two pagination steps, and three sort states — and six `lucide-react`
 * imports is around two kilobytes of gzipped bundle for six strokes of a
 * pen. The icon set earns its place where the glyph carries meaning a word
 * would not; a chevron is a chevron.
 *
 * Same geometry as the set they replace (a 24-unit box, 2-unit round stroke)
 * so they sit at the same weight as the icons beside them.
 */
export function Chevron({
  direction,
  className,
}: {
  readonly direction: 'up' | 'down' | 'left' | 'right' | 'both';
  readonly className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {direction === 'both' ? (
        <>
          <path d="m7 15 5 5 5-5" />
          <path d="m7 9 5-5 5 5" />
        </>
      ) : direction === 'up' ? (
        <path d="m18 15-6-6-6 6" />
      ) : direction === 'down' ? (
        <path d="m6 9 6 6 6-6" />
      ) : direction === 'left' ? (
        <path d="m15 18-6-6 6-6" />
      ) : (
        <path d="m9 18 6-6-6-6" />
      )}
    </svg>
  );
}
