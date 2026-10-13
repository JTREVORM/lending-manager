/**
 * Which file a report's letterhead mark is drawn from.
 *
 * No `server-only` marker, for the reason `csv.ts` gives and more pointedly:
 * the function below is a **whitelist on a value that comes out of the
 * database and reaches `readFile`**, and a control that cannot be unit-tested
 * is a control nobody can be sure of. It touches no database and opens no
 * file — it turns one string into another or refuses.
 *
 * ## Why the document's mark is not the web page's file
 *
 * The web uses the asset `company_settings.logo_path` names, which for this
 * business is a WebP. A PDF cannot: it embeds a JPEG by passing the compressed
 * bytes straight through `DCTDecode` — no decoder, no dependency, and the file
 * appears in the document verbatim — and it has no such path for WebP.
 *
 * So the document uses a JPEG *beside* the configured asset, by the same stem:
 * `/brand/polytos-logo.webp` is drawn from `/brand/polytos-logo.jpg`, which
 * `scripts/gen-logo-jpeg.py` generates from it. A business that replaces its
 * mark changes one row and runs that script, and both surfaces follow —
 * rather than the web showing the new logo while every printed report still
 * carries the old one.
 */

/** Where the default mark lives, for a deployment that has set no path. */
export const DEFAULT_LOGO_PATH = '/brand/polytos-logo.webp';

/**
 * The shape a stored logo path may have.
 *
 * A whitelist rather than an escape, because the value reaches the filesystem:
 * one leading slash, then the characters a path under `public/` actually
 * contains, then an extension. A URL, a traversal, a null byte, a shell
 * metacharacter or a bare name all fail to match and are refused.
 *
 * Note that matching is not on its own the boundary. The caller joins the
 * result under `public/`, and `path.join` keeps a leading-slash segment inside
 * the base — so even a path that slipped through could not escape it. This is
 * the first of the two, and the one that can be read.
 */
const SAFE_PUBLIC_PATH = /^\/[A-Za-z0-9/_-]+\.[A-Za-z0-9]+$/;

/**
 * The JPEG a configured logo path implies, or null if the path is unusable.
 *
 * Null is not an error the caller reports to anybody: a letterhead with the
 * company's name, tagline, numbers and addresses but no mark is still a valid
 * letterhead, and refusing a download because an asset was unreadable would be
 * the wrong trade.
 */
export function letterheadJpegPath(logoPath: string | null): string | null {
  const configured = logoPath ?? DEFAULT_LOGO_PATH;

  if (!SAFE_PUBLIC_PATH.test(configured)) return null;
  // Belt and braces: `.` is not in the character class above, so a traversal
  // cannot match — but the check costs nothing and the consequence of being
  // wrong is reading an arbitrary file.
  if (configured.includes('..')) return null;

  return `${configured.replace(/\.[A-Za-z0-9]+$/, '')}.jpg`;
}
