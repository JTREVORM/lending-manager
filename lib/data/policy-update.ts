import 'server-only';

import { mapDatabaseError } from '@/lib/db-errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function getMemberPolicyPosition(
  membershipId: string,
  canSavings = true,
  canBenefits = true,
) {
  const db = await createSupabaseServerClient();
  const [savings, benefits] = await Promise.all([
    canSavings
      ? db.rpc('member_savings_position', { p_membership_id: membershipId })
      : Promise.resolve({ data: [], error: null }),
    canBenefits
      ? db.rpc('member_benefit_position', { p_membership_id: membershipId })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (savings.error) throw mapDatabaseError(savings.error);
  if (benefits.error) throw mapDatabaseError(benefits.error);
  return { savings: savings.data?.[0] ?? null, benefits: benefits.data?.[0] ?? null };
}

export async function listMeetingPolicyWork(meetingId: string) {
  const db = await createSupabaseServerClient();
  const [notices, fines] = await Promise.all([
    db
      .from('meeting_absence_notice_register')
      .select('*')
      .eq('meeting_id', meetingId)
      .order('reported_at', { ascending: false }),
    db
      .from('meeting_fine_register')
      .select('*')
      .eq('meeting_id', meetingId)
      .order('fine_number'),
  ]);
  if (notices.error) throw mapDatabaseError(notices.error);
  if (fines.error) throw mapDatabaseError(fines.error);
  return { notices: notices.data ?? [], fines: fines.data ?? [] };
}

export async function getLoanCollections(loanId: string) {
  const db = await createSupabaseServerClient();
  const result = await db
    .from('loan_collection_schedule')
    .select('*')
    .eq('loan_id', loanId)
    .order('installment_number');
  if (result.error) throw mapDatabaseError(result.error);
  return result.data ?? [];
}

export async function getPolicyBusinessNow(): Promise<number> {
  const db = await createSupabaseServerClient();
  const result = await db.rpc('business_now');
  if (result.error) throw mapDatabaseError(result.error);
  if (typeof result.data !== 'string' || !Number.isFinite(Date.parse(result.data))) {
    throw new Error('The business clock could not be read.');
  }
  return Date.parse(result.data);
}
