import { KeyRound } from 'lucide-react';

import { ChangePasswordForm } from '@/components/auth/change-password-form';
import { Alert } from '@/components/ui/alert';
import { Card, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';

export const metadata = { title: 'Change password' };

/**
 * Change password.
 *
 * Also the forced destination for an account still holding an
 * administrator-issued temporary password: the route guard sends such a user
 * here and refuses everywhere else, because until it is changed, somebody
 * other than the account holder knows the password.
 */
export default async function ChangePasswordPage() {
  const context = await guardPermission(ROUTES.changePassword, 'account:view');

  return (
    <div className="mx-auto max-w-lg space-y-5">
      <PageHeader
        eyebrow="Account Security"
        icon={KeyRound}
        back={{ href: ROUTES.account, label: 'My account' }}
        title="Change password"
        description="Choose something only you know. You will stay signed in on this device."
      />

      {context.mustChangePassword ? (
        <Alert tone="warning" title="Choose your own password">
          You signed in with a password your administrator set, so they know it too.
          Choose a new one now — you will not be able to use the rest of the system until
          you do.
        </Alert>
      ) : null}

      <Card>
        <CardHeader
          title="New password"
          description="You will stay signed in on this device."
        />
        <ChangePasswordForm />
      </Card>
    </div>
  );
}
