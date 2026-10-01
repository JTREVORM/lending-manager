import Link from 'next/link';
import { notFound } from 'next/navigation';

import { GuarantorForm } from '@/components/guarantors/guarantor-form';
import { ROUTES } from '@/config/app';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { getGuarantor, getGuarantorNin } from '@/lib/data/guarantors';

export const metadata = { title: 'Edit guarantor' };

export default async function EditGuarantorPage({
  params,
}: {
  readonly params: Promise<{ readonly guarantorId: string }>;
}) {
  const { guarantorId } = await params;
  const context = await guardPermission(
    `${ROUTES.guarantors}/${guarantorId}/edit`,
    'guarantors:update',
  );

  const guarantor = await getGuarantor(guarantorId);

  if (guarantor === null) notFound();

  const canSeeNin = contextCan(context, 'guarantors:view_nin');
  const nin = canSeeNin ? await getGuarantorNin(guarantorId) : null;

  return (
    <div className="min-w-0 space-y-6">
      <div className="min-w-0">
        <Link
          href={`${ROUTES.guarantors}/${guarantor.id}`}
          className="text-accent focus-visible:outline-accent text-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          ← {guarantor.fullName}
        </Link>
        <h1 className="text-text mt-2 text-2xl font-semibold break-words">
          Edit {guarantor.fullName}
        </h1>
      </div>

      <GuarantorForm guarantor={guarantor} nin={nin} canRecordNin={canSeeNin} />
    </div>
  );
}
