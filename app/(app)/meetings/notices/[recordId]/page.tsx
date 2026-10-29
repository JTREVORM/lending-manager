import { notFound, redirect } from 'next/navigation';
import { guardPermission } from '@/lib/auth/guard';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { mapDatabaseError } from '@/lib/db-errors';

export default async function MeetingRecordLink({ params }: { readonly params: Promise<{ readonly recordId: string }> }) {
  await guardPermission('/meetings', 'meetings:view');
  const { recordId } = await params;
  const db = await createSupabaseServerClient();
  const result = await db.from('meeting_absence_notices').select('meeting_id').eq('id', recordId).maybeSingle();
  if (result.error) throw mapDatabaseError(result.error);
  if (!result.data) notFound();
  redirect(`/meetings/${result.data.meeting_id}`);
}
