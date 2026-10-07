import { HeartHandshake } from 'lucide-react';

import Link from 'next/link';

import { GuarantorForm } from '@/components/guarantors/guarantor-form';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';

export const metadata = { title: 'Register a guarantor' };

/**
 * Register a guarantor.
 *
 * `clientId` arrives in the query string when the flow started from a client's
 * page, in which case the guarantor is attached to that client in the same
 * submission. It is a convenience, not an authorisation: attaching needs
 * `guarantors:link`, and the policy on `client_guarantors` enforces it whatever
 * the query string says.
 */
export default async function NewGuarantorPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await guardPermission(`${ROUTES.guarantors}/new`, 'guarantors:create');

  const params = await searchParams;
  const rawClientId = typeof params.clientId === 'string' ? params.clientId : null;

  // Only a well-formed identifier is carried through. A malformed one is
  // dropped rather than passed on to fail validation later.
  const attachTo =
    rawClientId !== null &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawClientId)
      ? rawClientId
      : undefined;

  const canLink = contextCan(context, 'guarantors:link');

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Loan Security"
        icon={HeartHandshake}
        back={{
          href:
            attachTo === undefined ? ROUTES.guarantors : `${ROUTES.clients}/${attachTo}`,
          label: 'Back',
        }}
        title="Register a guarantor"
        description={
          <>
            Check the{' '}
            <Link
              href={ROUTES.guarantors}
              className="font-semibold text-white underline decoration-amber-300 underline-offset-4 hover:text-amber-200"
            >
              directory
            </Link>{' '}
            first. If this person already guarantees another client, attach the existing
            record instead of making a second one.
          </>
        }
      />

      {attachTo !== undefined && !canLink ? (
        <Alert tone="warning">
          You can register this guarantor, but you do not have permission to attach them
          to a client. Someone with that permission will need to complete the attachment.
        </Alert>
      ) : null}

      <GuarantorForm
        canRecordNin={contextCan(context, 'guarantors:view_nin')}
        attachToClientId={canLink ? attachTo : undefined}
      />
    </div>
  );
}
