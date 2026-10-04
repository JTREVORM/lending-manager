import { APP_DESCRIPTION, APP_NAME, APP_SHORT_NAME, ROUTES } from '@/config/app';

/**
 * The web app manifest.
 *
 * ## Why a route rather than a static file
 *
 * Nothing in it is secret, but it is the one place the installed application's
 * identity is declared, and declaring it next to the constants it is built
 * from means the installed name cannot drift from the name in the interface.
 *
 * It is served without a session — an install prompt is offered before anyone
 * signs in — so it carries no company detail from the database. The company's
 * own name appears inside the application; the installed icon is the
 * software's.
 *
 * ## start_url
 *
 * `/` rather than `/login`. The proxy sends an unauthenticated visitor to
 * sign in and a signed-in one to their landing page, so one entry point is
 * correct for both and an installed shortcut does not strand a signed-in user
 * on a sign-in screen.
 */
export const dynamic = 'force-static';

export function GET(): Response {
  const manifest = {
    name: APP_NAME,
    short_name: APP_SHORT_NAME,
    description: APP_DESCRIPTION,
    start_url: ROUTES.dashboard,
    scope: '/',

    // `standalone`, not `fullscreen`: staff need the system clock and the
    // battery indicator while they work a counter, and a borrower checking a
    // balance should still be able to see where they are.
    display: 'standalone',

    // Deliberately not locked. A statement and a schedule table are easier to
    // read in landscape, and forcing portrait on a tablet would be a
    // regression from the browser.
    orientation: 'any',

    // The brand green, which is what the header and the primary action use.
    // A theme colour that disagreed with the interface is worse than none:
    // the system chrome would frame the application in a colour it never
    // shows.
    theme_color: '#0f6a41',
    // The page background in light mode, so the splash screen does not flash
    // a different colour before the application paints.
    background_color: '#f7f8f9',

    lang: 'en-UG',
    dir: 'ltr',
    categories: ['business', 'finance'],

    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      // A maskable icon is drawn edge to edge and cropped by the launcher to
      // whatever shape the platform uses. Without one, Android puts the
      // square icon on a white plate with a visible border.
      {
        src: '/icons/icon-maskable-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],

    // The two things staff reach for most, straight from a long-press on the
    // installed icon. Both are capability-guarded on arrival, so a borrower
    // following one lands on a refusal rather than a screen.
    shortcuts: [
      {
        name: 'Record a payment',
        short_name: 'Payment',
        url: `${ROUTES.payments}/new`,
        icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }],
      },
      {
        name: 'Overdue loans',
        short_name: 'Overdue',
        url: ROUTES.overdue,
        icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }],
      },
    ],

    prefer_related_applications: false,
  };

  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      'content-type': 'application/manifest+json; charset=utf-8',
      // Safe to cache: it holds no session and no company data.
      'cache-control': 'public, max-age=3600',
    },
  });
}
