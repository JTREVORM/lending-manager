import { PhasePlaceholder } from '@/components/layout/phase-placeholder';

export const metadata = { title: 'Loans' };

export default function LoansPage() {
  return (
    <PhasePlaceholder
      title="Loans"
      phase={3}
      summary="Loan origination and the interest engine arrive with Phase 3."
      planned={[
        'Create a loan within the configured minimum and maximum amounts',
        'Apply monthly interest to the reducing principal, at the configured rate',
        'Generate a repayment schedule at the chosen cadence (daily, every 2 days, every 3 days)',
        'Snapshot the loan terms at origination, so a later settings change never rewrites an agreed schedule',
        'Enforce the configured limit on concurrent active loans per client',
      ]}
    />
  );
}
