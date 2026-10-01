import { Construction } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';

export const metadata = { title: 'My loans' };

/**
 * The client portal landing page.
 *
 * A borrower who signs in reaches this. There is nothing to show yet, because
 * loans are a later phase — so it says so plainly rather than rendering an
 * empty balance that might be mistaken for a real one of zero.
 */
export default async function PortalPage() {
  const context = await guardPermission(ROUTES.portal, 'portal:view');

  return (
    <div className="space-y-5">
      <header>
        <h1>Welcome, {context.fullName.split(' ')[0]}</h1>
        <p className="text-text-muted mt-1 text-sm">Your account with us.</p>
      </header>

      <Card>
        <div className="flex gap-3">
          <span className="bg-info-surface flex size-10 shrink-0 items-center justify-center rounded-lg">
            <Construction aria-hidden="true" className="text-info size-5" />
          </span>
          <div className="min-w-0 space-y-3">
            <div>
              <h2 className="text-base">Your loan details are being prepared</h2>
              <p className="text-text-muted mt-1 text-sm">
                Your account is set up and you can sign in, but loan information is not
                available here yet. Please continue to speak to our staff about your
                balance and repayments in the meantime.
              </p>
            </div>

            <div>
              <h3 className="text-sm font-semibold">What you will see here</h3>
              <ul className="text-text-muted mt-1.5 list-disc space-y-1 pl-5 text-sm">
                <li>Your current loan and how much is left to pay</li>
                <li>Your repayment schedule and the next amount due</li>
                <li>Every payment you have made, with its receipt number</li>
              </ul>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
