import type { Metadata, Viewport } from 'next';

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
  colorScheme: 'light dark',

  // Matched to the two surfaces the application actually paints, so the
  // system chrome does not frame it in a colour it never shows. A single
  // value would be wrong in one of the two themes.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f8f9' },
    { media: '(prefers-color-scheme: dark)', color: '#14181c' },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
        {/* Registers the worker and offers an update when one is waiting.
            Renders nothing until there is something to say. */}
        <ServiceWorkerProvider />
      </body>
    </html>
  );
}
