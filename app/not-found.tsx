import { ROUTES } from '@/config/app';
import { Card } from '@/components/ui/card';
import { ActionLink } from '@/components/ui/page-header';

export const metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md items-center justify-center px-4 py-10">
      <Card className="w-full text-center">
        <p className="text-text-muted text-sm font-semibold">404</p>
        <h1 className="mt-1">Page not found</h1>
        <p className="text-text-muted mt-2 text-sm">
          That page does not exist, or it has moved. If you followed a link from inside
          the system, please let your administrator know.
        </p>
        {/* A navigation control is a link, not a button. */}
        <ActionLink href={ROUTES.dashboard} className="mt-5">
          Return to the dashboard
        </ActionLink>
      </Card>
    </main>
  );
}
