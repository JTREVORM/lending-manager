'use client';

/**
 * Last-resort error boundary, for a failure in the root layout itself.
 *
 * At this point the layout has not rendered, so this component must supply its
 * own `<html>` and `<body>` and cannot rely on the global stylesheet or any
 * shared component. Styles are therefore inline — the one place in this
 * codebase where that is correct.
 *
 * No error detail is shown, in any environment: a root-layout failure is the
 * case most likely to involve configuration, and configuration errors name
 * environment variables.
 */
export default function GlobalError({ reset }: { readonly reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1.5rem',
          background: '#f4f0e9',
          color: '#25221f',
        }}
      >
        <div style={{ maxWidth: '28rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', margin: '0 0 0.75rem' }}>
            The application could not start
          </h1>
          <p style={{ fontSize: '0.875rem', lineHeight: 1.6, margin: '0 0 1.5rem' }}>
            Something went wrong while loading the system. No data has been changed.
            Please try again, and contact your administrator if the problem continues.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              minHeight: '2.75rem',
              padding: '0 1.25rem',
              fontSize: '0.875rem',
              fontWeight: 500,
              color: '#ffffff',
              background: '#00514f',
              border: 'none',
              borderRadius: '0.625rem',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
