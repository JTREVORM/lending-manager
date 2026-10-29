import Link from 'next/link';

import { Card } from '@/components/ui/card';
import { DateValue } from '@/components/ui/data-value';
import { listMeetingPolicyWork } from '@/lib/data/policy-update';
import type { ExpectedMember } from '@/lib/data/meetings';
import { OperationForm } from './operation-form';
import { PolicyAmount } from './amount';

export async function MeetingPolicyWork({ meetingId, members, canRecord, canReview, canAssess }: {
  readonly meetingId: string;
  readonly members: readonly ExpectedMember[];
  readonly canRecord: boolean;
  readonly canReview: boolean;
  readonly canAssess: boolean;
}) {
  const { notices, fines } = await listMeetingPolicyWork(meetingId);
  return <section aria-label="Absence notices and fines" className="space-y-4">
    <Card>
      <h2 className="text-text font-semibold">Advance absence notifications</h2>
      <p>Record a member's notice before the meeting starts. Another officer reviews the reason. Pending notices hold the fine.</p>
      {canRecord ? <div className="mt-4"><OperationForm operation="record_notice" values={{ meetingId }}
        label="Record advance absence notice" fields={[
          { name: 'membershipId', label: 'Member reporting absence', required: true, options: members.map((m) => ({ value: m.membershipId, label: `${m.membershipNumber} — ${m.memberName}` })) },
          { name: 'reasonKind', label: 'Reason category', required: true, options: ['illness', 'travel', 'work', 'bereavement', 'family', 'not_stated', 'other'].map((value) => ({ value, label: value.replaceAll('_', ' ') })) },
          { name: 'reason', label: 'Reason reported by the member', required: true },
          { name: 'via', label: 'How the notice arrived', required: true, options: ['in_person', 'telephone', 'sms', 'through_another_member', 'written'].map((value) => ({ value, label: value.replaceAll('_', ' ') })) },
        ]} /></div> : null}
      <ul className="mt-4 divide-y">{notices.map((n) => <li key={n.id} className="space-y-2 py-3">
        <p>{n.membership_number} · {n.member_name} · {n.review_status}</p>
        <p>{n.reason} · Reported <DateValue value={n.reported_at} variant="datetime" /></p>
        {n.review_note ? <p>Review: {n.review_note}</p> : null}
        {canReview && n.review_status === 'pending' && n.id ? <OperationForm operation="review_notice"
          values={{ noticeId: n.id }} label="Record excuse decision" fields={[
            { name: 'decision', label: 'Excuse decision', required: true, options: [{ value: 'approved', label: 'Accept the reason' }, { value: 'rejected', label: 'Reject the reason' }] },
            { name: 'note', label: 'Review reason', required: true },
          ]} /> : null}
      </li>)}</ul>
    </Card>
    <Card>
      <h2 className="text-text font-semibold">Meeting absence fines</h2>
      <p>The governing policy sets the charge. The official draft records UGX 5,000; an unpaid charge is not cash or income.</p>
      <Link href="/meetings/fines" className="text-accent underline">Fine register and reconciliation</Link>
      {canAssess ? <div className="mt-4"><OperationForm operation="assess_fines" values={{ meetingId }} label="Assess eligible absence fines" /></div> : null}
      <ul className="mt-4 space-y-2">{fines.map((f) => <li key={f.id}>
        <Link href={`/meetings/fines/${f.id}`} className="text-accent underline">{f.fine_number} · {f.member_name}</Link>
        {' '}· {f.status} · <PolicyAmount value={f.amount_outstanding} /> outstanding
      </li>)}</ul>
      {fines.length === 0 ? <p className="mt-3">No fine has been assessed for this meeting.</p> : null}
    </Card>
  </section>;
}
