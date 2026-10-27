import { CalendarPlus } from 'lucide-react';

import { ScheduleMeetingForm } from '@/components/meetings/schedule-meeting-form';
import { PageHeader } from '@/components/ui/page-header';
import { ROUTES } from '@/config/app';
import { guardPermission } from '@/lib/auth/guard';
import { getBranchOptions } from '@/lib/data/products';

export const metadata = { title: 'Schedule a meeting' };

/**
 * Convening a meeting.
 *
 * The branches come from `getBranchOptions`, read as the caller — so somebody
 * who cannot see a branch cannot convene a meeting at it, and
 * `schedule_membership_meeting` checks the same thing again inside the
 * database because a `SECURITY DEFINER` function has no policies applied to
 * it.
 */
export default async function NewMeetingPage() {
  await guardPermission(ROUTES.newMeeting, 'meetings:manage');

  const branches = await getBranchOptions();

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Membership Meetings"
        icon={CalendarPlus}
        title="Schedule a meeting"
        description="One monthly general meeting per branch per month. Nothing here fixes a weekday, an hour or a quorum — the client has not set any."
        back={{ href: ROUTES.meetings, label: 'Meetings' }}
      />

      <ScheduleMeetingForm branches={branches} />
    </div>
  );
}
