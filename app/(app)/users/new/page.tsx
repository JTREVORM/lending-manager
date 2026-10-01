import Link from 'next/link';

import { CreateStaffForm } from '@/components/users/create-staff-form';
import { Alert } from '@/components/ui/alert';
import { Card, CardHeader } from '@/components/ui/card';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { assignableRoles } from '@/lib/data/users';

export const metadata = { title: 'Add staff member' };

export default async function NewUserPage() {
  await guardPermission(ROUTES.users, 'users:create');

  const roles = await assignableRoles();

  return (
    <div className="space-y-5">
      <header>
        <Link href={ROUTES.users} className="text-text-muted text-sm hover:underline">
          ← Back to users
        </Link>
        <h1 className="mt-2">Add staff member</h1>
      </header>

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
