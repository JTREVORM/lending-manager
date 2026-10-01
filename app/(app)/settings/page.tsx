import { PhasePlaceholder } from '@/components/layout/phase-placeholder';

export const metadata = { title: 'Settings' };

export default function SettingsPage() {
  return (
    <PhasePlaceholder
      title="Settings"
      phase={2}
      summary="The settings screens arrive with Phase 2. The database tables behind them already exist and hold the business's confirmed values."
      planned={[
        'Edit company details and branding, replacing the temporary name once registration completes',
        'Adjust the minimum and maximum loan amounts',
        'Adjust the monthly interest rate, grace period and penalty rate',
        'Manage repayment cadences',
        'Grant and revoke staff roles, with every change written to the audit trail',
      ]}
    />
  );
}
