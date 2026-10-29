import { randomUUID } from 'node:crypto';
import { Scale } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { PageHeader } from '@/components/ui/page-header';
import { PolicyAmount } from '@/components/policy-update/amount';
import { OperationForm } from '@/components/policy-update/operation-form';
import { contextCan } from '@/lib/auth/context';
import { guardPermission } from '@/lib/auth/guard';
import { mapDatabaseError } from '@/lib/db-errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const metadata = { title: 'Meeting fine' };

export default async function FinePage({ params }: { readonly params: Promise<{ readonly fineId: string }> }) {
  const context = await guardPermission('/meetings/fines', 'fines:view');
  const { fineId } = await params;
  const db = await createSupabaseServerClient();
  const [fine, receipts] = await Promise.all([
    db.from('meeting_fine_register').select('*').eq('id', fineId).maybeSingle(),
    db.from('meeting_fine_payments').select('*').eq('fine_id', fineId).order('created_at', { ascending: false }),
  ]);
  if (fine.error) throw mapDatabaseError(fine.error);
  if (receipts.error) throw mapDatabaseError(receipts.error);
  if (!fine.data?.id) notFound();
  const f = fine.data;
  const canReverse = contextCan(context, 'fines:reverse');
  return <div className="min-w-0 space-y-6">
    <PageHeader icon={Scale} eyebrow="Meeting Fines" title={f.fine_number ?? 'Meeting fine'}
      description={`${f.member_name} · ${f.membership_number}`}
      back={{ href: '/meetings/fines', label: 'Fine register' }} />
    <Card>
      <h2 className="font-semibold">Charge and attendance evidence</h2>
      <p><Link className="text-accent underline" href={`/meetings/${f.meeting_id}`}>{f.meeting_number}</Link> · <DateValue value={f.meeting_date} /></p>
      <p>Policy {f.policy_version} · Attendance: {f.attendance_at_assessment} · {f.status}</p>
      <p>Charged <PolicyAmount value={f.amount} />; collected <PolicyAmount value={f.amount_paid} />; outstanding <PolicyAmount value={f.status === 'cancelled' ? 0 : f.amount_outstanding} />.</p>
      <p>Assessed by {f.assessed_by_label} on <DateValue value={f.assessed_on} />.</p>
      {f.cancellation_reason ? <p>Cancellation: {f.cancellation_reason} · {f.cancelled_by_label}</p> : null}
    </Card>
    {contextCan(context, 'fines:collect') && f.status === 'outstanding' ? <Card>
      <h2 className="mb-3 font-semibold">Receive fine payment</h2>
      <OperationForm operation="collect_fine" values={{ fineId, key: randomUUID() }} label="Record fine payment" fields={[
        { name: 'amount', label: 'Amount received (UGX)', type: 'number', required: true },
        { name: 'method', label: 'Payment method', required: true, options: [
          { value: 'cash', label: 'Cash' }, { value: 'mtn_mobile_money', label: 'MTN Mobile Money' },
          { value: 'airtel_money', label: 'Airtel Money' }, { value: 'bank', label: 'Bank' },
        ] },
        { name: 'reference', label: 'Network or bank reference', hint: 'Leave blank for cash.' },
      ]} />
    </Card> : null}
    <Card>
      <h2 className="font-semibold">Receipt and reversal history</h2>
      <ul className="mt-3 divide-y">{(receipts.data ?? []).map((r) => <li key={r.id} className="space-y-2 py-3">
        <p>{r.payment_number} · <PolicyAmount value={r.amount} /> · {r.payment_method} · {r.status}</p>
        <p>Received by {r.received_by_label} on <DateValue value={r.value_date} />. Reference: {r.external_reference ?? 'cash receipt'}.</p>
        {r.reversal_reason ? <p>Reversed by {r.reversed_by_label}: {r.reversal_reason}</p> : null}
        {canReverse && r.status === 'posted' ? <OperationForm operation="reverse_fine_payment"
          values={{ paymentId: r.id }} label="Reverse this receipt"
          fields={[{ name: 'note', label: 'Receipt reversal reason', required: true }]} /> : null}
      </li>)}</ul>
      {receipts.data?.length === 0 ? <p>No money has been collected.</p> : null}
    </Card>
    {canReverse && f.status === 'outstanding' && f.amount_paid === 0 ? <Card>
      <h2 className="mb-3 font-semibold">Cancel an incorrect charge</h2>
      <OperationForm operation="cancel_fine" values={{ fineId }} label="Cancel this fine"
        fields={[{ name: 'note', label: 'Fine cancellation reason', required: true }]} />
    </Card> : null}
  </div>;
}
