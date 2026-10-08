import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';

import { ServiceWorkerProvider } from '@/components/pwa/service-worker-provider';
import { APP_DESCRIPTION, APP_NAME, APP_SHORT_NAME } from '@/config/app';

import './globals.css';

export const metadata: Metadata = {
  // A template, so each page sets only its own name and the company suffix is
  // applied once. The title comes from config, not a literal, so renaming the
  // business is a single change.
  title: {
    default: APP_NAME,
    template: `%s · ${APP_SHORT_NAME}`,
  },
  description: APP_DESCRIPTION,
  applicationName: APP_SHORT_NAME,
  // This is an internal business system holding client financial data. It must
  // never appear in a search index.
  robots: { index: false, follow: false },

  manifest: '/manifest.webmanifest',

  icons: {
    icon: [
      { url: '/favicon.png', type: 'image/png', sizes: '32x32' },
      { url: '/icons/icon-192.png', type: 'image/png', sizes: '192x192' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },

  // iOS reads these rather than the manifest when the application is added to
  // the home screen.
  appleWebApp: {
    capable: true,
    title: APP_SHORT_NAME,
    statusBarStyle: 'default',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Deliberately NOT maximum-scale=1 or user-scalable=no. Blocking zoom is a
  // WCAG failure, and staff reading small UGX figures in daylight need it.
  // `light`, not `light dark`.
  //
  // This is not a duplicate of the stylesheet's own light default. It tells
  // the browser which schemes the page supports, and the browser uses it for
  // the parts the stylesheet does not own: the canvas behind the document,
  // scrollbars, and the default rendering of form controls. Declaring
  // `light dark` while painting a light workspace gave staff on a dark-mode
  // device a white page with dark native selects and a dark scrollbar down
  // the side of it.
  //
  // It becomes `light dark` again on the day a deliberate theme switch ships
  // — the palette for it is already in `globals.css` under
  // `[data-theme="dark"]`.
  colorScheme: 'light',

  // The reference declares a single `theme-color` of `#0B4394` — the navy the
  // sidebar, the banners and the primary buttons are built from. One value,
  // because there is one scheme.
  themeColor: '#0B4394',
};

/**
 * Inter — the reference project's typeface, from the same source.
 *
 * The reference links the Google Fonts stylesheet
 * `css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap` from its
 * root route. This is that exact font at those exact weights, fetched from
 * Google Fonts at build time and then **self-hosted** by Next alongside the
 * application.
 *
 * Self-hosting rather than linking is the one place this file improves on the
 * reference instead of copying it, and it is not a substitution — the font
 * binaries are the same ones the reference's link resolves to:
 *
 *   - no third-party request on load, so no render-blocking round trip to
 *     `fonts.googleapis.com` before the first paint, which on a 3G phone at a
 *     counter is the difference between fast and not;
 *   - no IP address handed to Google by every member of staff on every visit;
 *   - `display: 'swap'`, as the reference's URL asks for, so text is legible
 *     in the fallback face immediately rather than invisible while the font
 *     arrives.
 *
 * All seven weights, not a subset: the design sets page titles in `font-black`
 * (900) and the sidebar's version chip in `font-extrabold` (800), and a
 * missing weight is silently faked by the browser as a smeared synthetic bold.
 *
 * Exposed as a CSS variable so `--font-sans` in `globals.css` — which is what
 * `body` and every `font-sans` utility resolve to — names it rather than a
 * class having to be threaded through the tree.
 */
const inter = Inter({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700', '800', '900'],
  display: 'swap',
  variable: '--font-inter',
  // The reference's own fallback chain, so the swapped-in face before Inter
  // arrives is the one it designed against.
  fallback: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
});

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="antialiased">
        {children}
        {/* Registers the worker and offers an update when one is waiting.
            Renders nothing until there is something to say. */}
        <ServiceWorkerProvider />
      </body>
    </html>
  );
}
