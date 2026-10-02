import { PhasePlaceholder } from '@/components/layout/phase-placeholder';

export const metadata = { title: 'Payments' };

export default function PaymentsPage() {
  return (
    <PhasePlaceholder
      title="Payments"
      phase={6}
      summary="Payment capture and receipts arrive with Phase 6; arrears and penalties with Phase 7."
      planned={[
        'Record a payment in cash, MTN Mobile Money or Airtel Money',
        'Issue a receipt number automatically (PAY260001, PAY260002, …)',
        'Allocate a payment against the scheduled collections already generated',
        'Accept an overpayment and apply the excess to future obligations',
        'Reverse a payment by writing a compensating record, never by deleting it',
        'Treat an unpaid collection as arrears, without rewriting the original schedule (Phase 7)',
      ]}
    />
  );
}
