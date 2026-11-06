-- ===========================================================================
-- Close the `client_has_live_loan` disclosure.
--
-- ## What was found
--
-- Phase 2B retested the nine functions the Phase 2 report carried as
-- PENDING-REVIEW, this time with real third-party identifiers rather than the
-- NULL arguments that could not reach a guard. Eight came back safe. This one
-- did not:
--
--   a client with a disbursed, active loan
--   what owner_admin, manager and secretary_treasurer saw:  true
--   what an UNRELATED BORROWER saw:                         true
--
-- The borrower holds no loan capability, has no relationship to that client and
-- shares no branch with them. They learned, correctly, that a named person is
-- carrying a live loan. Only the client's UUID was needed.
--
-- ## Why the existing guard did not stop it
--
-- `require_business_identity()`, exactly as with the savings amounts in
-- `20261106000500`: it refuses forced-password, inactive, suspended and
-- unlinked sessions and says nothing about capability, so every ordinary
-- borrower passes it. The function then queried `public.loans` directly as the
-- definer, which bypasses Row Level Security.
--
-- ## Why the other eight needed no change
--
-- Worth recording, because "produced no refusal" was what put them on the list
-- and it turned out to mean two different things.
--
-- Three refuse by raising `42501` once they have a real identifier to resolve:
-- `benefit_claim_eligibility`, `member_benefit_position` and
-- `meeting_fine_candidates`. The NULL probe never reached those raises because
-- each looks its record up first.
--
-- Three refuse by returning a safe value rather than raising, which is
-- idiomatic for their return types and is fail-closed:
-- `death_confirmation_count` and `condolence_next_of_kin_status` carry the
-- authorization predicate in the WHERE clause, so an unauthorized caller gets
-- `0` and zero rows — not the true count, and not an existence oracle either;
-- `benefit_payment_blocked_reason` returns the text
-- `'That claim cannot be read.'`, which is a reason, which is what it returns.
--
-- Two are guarded by what they call: `assess_meeting_fines` goes through
-- `meeting_fine_candidates` and `assess_meeting_fine`, and
-- `mark_notifications_read` scopes its write to the caller's own audience.
--
-- ## The guard
--
-- `lib/data/savings.ts` reads this for the withdrawal screen, so it can say why
-- a withdrawal is blocked before anyone fills the form in, with the caller's
-- own JWT. So a revoke would break that screen, and the guard has to admit
-- every role that reaches it.
--
-- Verified against the live capability matrix rather than assumed:
--
--   owner_admin          loans:view ✓   savings:view ✓
--   manager              loans:view ✓   savings:view ✓
--   secretary_treasurer  loans:view ✓   savings:view ✓
--   client (borrower)    loans:view ✗   savings:view ✗
--
-- Either capability is accepted, because the question is asked from a savings
-- screen about a loan, and a linked borrower may ask it about themselves — the
-- clause is prepared for the client portal in the same shape
-- `member_savings_position` and `require_savings_account_access` use. Trusted
-- no-JWT paths keep their bypass, so `request_savings_withdrawal` and
-- `post_savings_withdrawal`, which ask the same question again at the moment it
-- matters, are unaffected.
--
-- The body is otherwise unchanged: same signature, volatility, result and
-- owner, same `exists` over active loans. No row is read or written outside
-- that query, and no financial calculation, balance, schedule or journal entry
-- changes.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.client_has_live_loan(p_client_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
begin
  perform public.require_business_identity();

  -- Added 20261106000700. Whether a named person is carrying a live loan is a
  -- fact about that person, not about the caller. Trusted no-JWT maintenance
  -- and seed paths keep their existing bypass.
  if (select auth.uid()) is not null
     and not (select public.user_has_permission('loans:view'))
     and not (select public.user_has_permission('savings:view'))
     and not exists (
       select 1 from public.clients c
       where c.id = p_client_id
         and c.profile_id is not null
         and c.profile_id = (select public.current_profile_id())
     ) then
    raise exception
      'Reading whether a client holds a live loan requires loans:view or savings:view.'
      using errcode = '42501';
  end if;

  return exists (
    select 1 from public.loans l
    where l.client_id = p_client_id and l.status = 'active'
  );
end;
$function$;

COMMENT ON FUNCTION public.client_has_live_loan(uuid) IS
  'Whether this client holds a live loan. Read for the withdrawal screen, so it can say why a withdrawal is blocked before somebody fills in the form; request_savings_withdrawal asks the same question again at the moment it matters. As of 20261106000700 it requires loans:view or savings:view, or the client''s own linked session: until then require_business_identity alone let any active borrower ask it about any client.';

REVOKE ALL ON FUNCTION public.client_has_live_loan(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.client_has_live_loan(uuid) TO authenticated;
