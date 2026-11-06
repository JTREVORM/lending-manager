-- ===========================================================================
-- Make `assess_meeting_fines` refuse up front, like its singular sibling.
--
-- ## What the retest found, and what it did not
--
-- This is not a disclosure, and nothing here closes a leak. The Phase 2B
-- retest of the nine PENDING-REVIEW functions found `assess_meeting_fines`
-- already fail-closed on everything that matters, through what it calls:
--
--   public.meeting_fine_candidates   requires fines:view or fines:assess,
--                                    and the caller's branch
--   public.assess_meeting_fine       requires fines:assess
--
-- Both are SECURITY DEFINER, and `auth.uid()` is still the end user inside a
-- definer function, so both guards fire for the real caller. An unrelated
-- borrower is refused by the first one before a single row is read.
--
-- The application also gates it twice over: `lib/policy-update/actions.ts`
-- maps the `assess_fines` operation to `fines:assess`, and
-- `app/(app)/meetings/[meetingId]/page.tsx` only renders the control for a
-- session that holds it.
--
-- ## So why change it
--
-- Because of *when* it refuses. The `fines:assess` check lives in the loop
-- body, so it only runs if the loop has something to iterate. A session with
-- `fines:view` but not `fines:assess` — `secretary_treasurer` — calling this
-- against a meeting with no fineable candidates gets `0` rather than a
-- refusal. Nothing is disclosed (`0` is what an authorized caller sees too)
-- and nothing is written, so this was never exploitable.
--
-- It is still worth fixing, because "this function refuses you, provided there
-- is work to do" is a property nobody will remember. The singular
-- `assess_meeting_fine` checks `fines:assess` as its first act; the plural one
-- should read the same way. Authorization that depends on whether data happens
-- to exist is the kind of thing that is correct today and quietly wrong after
-- the next change.
--
-- ## What this cannot break
--
-- The capability asked for here is exactly the one the server action and the
-- screen already require, so no caller that reaches this function legitimately
-- can be turned away by it. `secretary_treasurer` loses a silent no-op it was
-- never entitled to perform. Trusted no-JWT paths keep their bypass.
--
-- The loop, the ordering, the candidate filter and the returned count are
-- unchanged, as are the signature, volatility, result type and owner. No fine
-- is assessed, cancelled or re-priced by this migration, and no row is read or
-- written.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.assess_meeting_fines(p_meeting_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_row   record;
  v_count integer := 0;
begin
  perform public.require_business_identity();

  -- Added 20261106000800, mirroring public.assess_meeting_fine. Previously
  -- this was enforced only by the loop body, so it did not fire for a meeting
  -- with nothing to assess.
  if (select auth.uid()) is not null
     and not (select public.user_has_permission('fines:assess')) then
    raise exception 'Assessing meeting fines requires the fines:assess capability.'
      using errcode = '42501';
  end if;

  for v_row in
    select k.membership_id
    from public.meeting_fine_candidates(p_meeting_id) k
    where k.fineable
    order by k.membership_number
  loop
    perform public.assess_meeting_fine(p_meeting_id, v_row.membership_id);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

COMMENT ON FUNCTION public.assess_meeting_fines(uuid) IS
  'Assesses the absence fine for every fineable member at a meeting, and returns how many it wrote. As of 20261106000800 it requires fines:assess as its first act, mirroring assess_meeting_fine: the loop body enforced the same capability but only when there was at least one candidate to iterate, so a fines:view-only session got a silent zero instead of a refusal.';
