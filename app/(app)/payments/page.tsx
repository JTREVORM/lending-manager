import { PhasePlaceholder } from '@/components/layout/phase-placeholder';

export const metadata = { title: 'Payments' };

export default function PaymentsPage() {
  return (
    <PhasePlaceholder
      title="Payments"
      phase={4}
      summary="Payment capture, arrears and penalties arrive with Phase 4."
      planned={[
        'Record a payment in cash, MTN Mobile Money or Airtel Money',
        'Issue a receipt number automatically (PAY260001, PAY260002, …)',
        'Accept the exact installment or an overpayment, and carry a missed amount into the next one due',
        'Apply the one-time penalty once the grace period has passed',
        'Reverse a payment by writing a compensating record, never by deleting it',
      ]}
    />
  );
}
