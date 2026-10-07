import { HeartHandshake } from 'lucide-react';

import { notFound } from 'next/navigation';

import { GuarantorForm } from '@/components/guarantors/guarantor-form';
import { PageHeader } from '@/components/ui/page-header';
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
      <PageHeader
        eyebrow="Loan Security"
        icon={HeartHandshake}
        back={{
          href: `${ROUTES.guarantors}/${guarantor.id}`,
          label: guarantor.fullName,
        }}
        title={`Edit ${guarantor.fullName}`}
      />

      <GuarantorForm guarantor={guarantor} nin={nin} canRecordNin={canSeeNin} />
    </div>
  );
}
