import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';

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
 * The same Inter typeface is packaged locally to keep builds independent of
 * Google Fonts responses and Next's Google-font URL parser.
 *
 * Source: fontsource/font-files, fonts/variable/inter/files/
 * inter-latin-wght-normal.woff2 at 2ffd3aa25908df6ed1c864de40ce53e2ae1076d1.
 * Upstream Git blob: d15208de03cd1ad7c5199f0a0ce915fe841e4722.
 * The Latin subset retains the existing preload scope and download budget.
 * The unmodified font's SIL Open Font License is in app/fonts/OFL.txt.
 * The CSS variable, supported weights, swap behavior and fallback chain stay
 * consistent with the existing application typography.
 */
const inter = localFont({
  src: './fonts/InterVariable.woff2',
  weight: '300 900',
  style: 'normal',
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
