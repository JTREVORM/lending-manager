import Link from 'next/link';
import type { ComponentProps } from 'react';

/**
 * A link rendered once per row of a list.
 *
 * ## Why this exists rather than `<Link>`
 *
 * Next.js prefetches `<Link>` by default: it fetches the destination's React
 * payload before anybody clicks. On a handful of fixed navigation
 * destinations that is a good trade — the person is likely to use one of
 * them, and the page opens instantly.
 *
 * On a list it is not. Opening `/clients` rendered twenty rows, each a
 * `<Link>`, and the browser then downloaded twenty client pages nobody had
 * asked for: a measured 54 network requests for one screen, of which 40 were
 * prefetches. For an office on a fixed line that is invisible. For a field
 * officer on a phone, on mobile data, it is twenty pages of somebody's
 * airtime spent on records they will never open — and twenty round trips on a
 * connection where a round trip is the expensive part.
 *
 * So every link that is rendered *per row* goes through here, and here says
 * `prefetch={false}` once with the reason attached. The row still opens on a
 * tap; it just opens when asked.
 *
 * ## When not to use it
 *
 * The navigation, a "Record a payment" button, a breadcrumb — anything there
 * is one of on the page and a person is likely to use. Those keep the default
 * and should.
 */
export function RowLink({ prefetch = false, ...props }: ComponentProps<typeof Link>) {
  return <Link prefetch={prefetch} {...props} />;
}
