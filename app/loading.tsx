import { Spinner } from '@/components/ui/spinner';

/**
 * Route-level loading state.
 *
 * Shown by Next.js while a Server Component's data is in flight.
 */
export default function Loading() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <Spinner label="Loading the page" />
    </div>
  );
}
