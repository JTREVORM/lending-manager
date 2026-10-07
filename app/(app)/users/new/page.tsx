import { UserPlus } from 'lucide-react';

import { CreateStaffForm } from '@/components/users/create-staff-form';
import { Alert } from '@/components/ui/alert';
import { Card, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { assignableRoles } from '@/lib/data/users';

export const metadata = { title: 'Add staff member' };

export default async function NewUserPage() {
  await guardPermission(ROUTES.users, 'users:create');

  const roles = await assignableRoles();

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Access Control"
        icon={UserPlus}
        back={{ href: ROUTES.users, label: 'Users' }}
        title="Add staff member"
        description="They sign in with the phone number recorded here."
      />

      <Alert tone="info" title="How the password reaches them">
        There is no email or SMS delivery in this system yet, so the temporary password
        must be handed over in person or read out on a call you initiated. It is shown to
        you once and stored only as a hash.
      </Alert>

      <Card>
        <CardHeader
          title="Account details"
          description="The staff member signs in with their phone number."
        />
        <CreateStaffForm assignableRoles={roles} />
      </Card>
    </div>
  );
}
