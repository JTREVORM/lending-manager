-- ===========================================================================
-- Close a confirmed cross-member savings disclosure.
--
-- ## What was found, and how
--
-- Phase 2 probed every SECURITY DEFINER function an `authenticated` session may
-- execute, as a borrower holding no business capability, rather than reading
-- bodies for the name of a guard. `savings_withdrawable_amount` and
-- `savings_pledged_amount` came back without refusing, so they were tested with
-- a real third party's account on a throwaway database:
--
--   a member's savings account, one 750,000 deposit
--   the owner saw            750000
--   an UNRELATED BORROWER saw 750000
--
-- An active identity with no savings capability, no relationship to the member
-- and no branch in common read that member's true withdrawable balance. Only
-- the account's UUID was needed.
--
-- ## Why the existing guard did not stop it
--
-- Both functions already called `require_business_identity()`, and
-- 20261103000100 listed them among the RPCs it had guarded. That guard is real
-- but answers a different question: it refuses forced-password, inactive,
-- suspended and unlinked sessions. It says nothing about capability, so every
-- ordinary borrower passes it. The classification was accurate about what the
-- guard does and wrong about what it was sufficient for — which is precisely
-- the failure mode that reading a body for a helper name cannot catch, and the
-- reason the behavioural probe exists.
--
-- ## The guard this adds
--
-- `public.member_savings_position` already answers "who may read this member's
-- savings?" and has done since Phase 3. Its answer is reused verbatim rather
-- than invented again: the caller's branch must cover the membership, and the
-- caller must hold `savings:view` or `member_loans:view_eligibility`, or be the
-- linked borrower reading their own account. Trusted no-JWT paths keep their
-- bypass.
--
-- That shared answer now lives in one function,
-- `require_savings_account_access`, which both wrappers call. One place to read,
-- one place to change.
--
-- ## Why a rename and a wrapper rather than an edited body
--
-- The same reason as 20261106000100: `ALTER FUNCTION ... RENAME TO` moves the
-- existing body byte for byte, so the withdrawal arithmetic — balance, pledges,
-- the policy's `savings_withdrawal_with_active_loan` rule and its undecided
-- case — is not retyped and cannot be mistyped. No financial calculation
-- changes.
--
-- The renamed functions lose their `authenticated` grant, which takes them off
-- the Data API. `postgres` and `service_role` keep EXECUTE, so the four
-- internal callers — `approve_loan`, `member_loan_eligibility_of`,
-- `request_savings_withdrawal` and `post_savings_withdrawal`, each of which
-- checks its own capability first — are unaffected.
--
-- A plain revoke would have been smaller, and was rejected: the
-- `member_loan_eligibility` view is `security_invoker = true`, so whoever reads
-- it needs EXECUTE on these functions in their own right. Revoking would break
-- the eligibility screen for the staff who are supposed to use it. Guarding
-- lets that view keep working for a caller holding
-- `member_loans:view_eligibility`, which the guard accepts.
--
-- Signatures, argument defaults, volatility, result types and owners are
-- unchanged. No row, financial record, journal entry, account, policy version
-- or audit entry is touched.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The shared answer to "may this caller read this savings account?"
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.require_savings_account_access(
  p_savings_account_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_membership public.memberships;
begin
  -- Active account with a completed password change. Null-returning for
  -- trusted no-JWT paths, deliberately.
  perform public.require_business_identity();

  if (select auth.uid()) is null then
    return;
  end if;

  select m.* into v_membership
  from public.savings_accounts a
  join public.memberships m on m.id = a.membership_id
  where a.id = p_savings_account_id;

  -- An account nobody can name is not a disclosure. The caller's own function
  -- decides what to return for a missing account, exactly as it did before.
  if not found then
    return;
  end if;

  if not (select public.user_can_see_branch(v_membership.branch_id)) then
    raise exception 'You cannot read that branch''s member savings.'
      using errcode = '42501';
  end if;

  if not (select public.user_has_permission('savings:view'))
     and not (select public.user_has_permission('member_loans:view_eligibility'))
     and not exists (
       select 1 from public.clients c
       where c.id = v_membership.client_id
         and c.profile_id is not null
         and c.profile_id = (select public.current_profile_id())
     ) then
    raise exception
      'Reading a member''s savings amounts requires savings:view or member_loans:view_eligibility.'
      using errcode = '42501';
  end if;
end;
$function$;

COMMENT ON FUNCTION public.require_savings_account_access(uuid) IS
  'Phase 2 security hardening (20261106000500). The one answer to who may read a savings account''s amounts: the caller''s branch must cover the membership, and the caller must hold savings:view or member_loans:view_eligibility, or be the linked borrower reading their own account. Mirrors member_savings_position. Trusted no-JWT paths are exempt. INTERNAL: deliberately not granted to authenticated.';

REVOKE ALL ON FUNCTION public.require_savings_account_access(uuid)
  FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- savings_pledged_amount
-- ---------------------------------------------------------------------------
DO $rename_pledged$
BEGIN
  IF to_regprocedure('public.savings_pledged_amount_internal(uuid, date)')
     IS NOT NULL THEN
    RAISE NOTICE 'savings_pledged_amount_internal already exists; skipping rename';
    RETURN;
  END IF;
  IF to_regprocedure('public.savings_pledged_amount(uuid, date)') IS NULL THEN
    RAISE EXCEPTION
      'public.savings_pledged_amount(uuid, date) is absent: refusing to guard a function that is not there';
  END IF;
  ALTER FUNCTION public.savings_pledged_amount(uuid, date)
    RENAME TO savings_pledged_amount_internal;
END;
$rename_pledged$;

REVOKE ALL ON FUNCTION public.savings_pledged_amount_internal(uuid, date)
  FROM public, anon, authenticated;

COMMENT ON FUNCTION public.savings_pledged_amount_internal(uuid, date) IS
  'The savings pledged against a member''s approved or active loans. INTERNAL as of 20261106000500: not granted to authenticated, so it is unreachable through the Data API. Reach it through public.savings_pledged_amount(uuid, date), which checks access first, or from inside a SECURITY DEFINER function that has already checked its own capability.';

CREATE OR REPLACE FUNCTION public.savings_pledged_amount(
  p_savings_account_id uuid,
  p_as_of date DEFAULT NULL::date
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
begin
  perform public.require_savings_account_access(p_savings_account_id);

  return public.savings_pledged_amount_internal(p_savings_account_id, p_as_of);
end;
$function$;

COMMENT ON FUNCTION public.savings_pledged_amount(uuid, date) IS
  'The savings pledged against a member''s approved or active loans. As of 20261106000500 a thin authorized wrapper: it requires savings:view, member_loans:view_eligibility or the member''s own linked session, then delegates unchanged to savings_pledged_amount_internal.';

REVOKE ALL ON FUNCTION public.savings_pledged_amount(uuid, date)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.savings_pledged_amount(uuid, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- savings_withdrawable_amount
-- ---------------------------------------------------------------------------
DO $rename_withdrawable$
BEGIN
  IF to_regprocedure('public.savings_withdrawable_amount_internal(uuid, date)')
     IS NOT NULL THEN
    RAISE NOTICE
      'savings_withdrawable_amount_internal already exists; skipping rename';
    RETURN;
  END IF;
  IF to_regprocedure('public.savings_withdrawable_amount(uuid, date)') IS NULL THEN
    RAISE EXCEPTION
      'public.savings_withdrawable_amount(uuid, date) is absent: refusing to guard a function that is not there';
  END IF;
  ALTER FUNCTION public.savings_withdrawable_amount(uuid, date)
    RENAME TO savings_withdrawable_amount_internal;
END;
$rename_withdrawable$;

REVOKE ALL ON FUNCTION public.savings_withdrawable_amount_internal(uuid, date)
  FROM public, anon, authenticated;

COMMENT ON FUNCTION public.savings_withdrawable_amount_internal(uuid, date) IS
  'How much of a member''s savings may be withdrawn, after pledges and the governing policy''s active-loan rule. Returns null where that rule is undecided. INTERNAL as of 20261106000500: not granted to authenticated, so it is unreachable through the Data API. Reach it through public.savings_withdrawable_amount(uuid, date), which checks access first.';

CREATE OR REPLACE FUNCTION public.savings_withdrawable_amount(
  p_savings_account_id uuid,
  p_as_of date DEFAULT NULL::date
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
begin
  perform public.require_savings_account_access(p_savings_account_id);

  return public.savings_withdrawable_amount_internal(p_savings_account_id, p_as_of);
end;
$function$;

COMMENT ON FUNCTION public.savings_withdrawable_amount(uuid, date) IS
  'How much of a member''s savings may be withdrawn, after pledges and the governing policy''s active-loan rule. Returns null where that rule is undecided. As of 20261106000500 a thin authorized wrapper: it requires savings:view, member_loans:view_eligibility or the member''s own linked session, then delegates unchanged to savings_withdrawable_amount_internal. Do not move the withdrawal arithmetic back into this function.';

REVOKE ALL ON FUNCTION public.savings_withdrawable_amount(uuid, date)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.savings_withdrawable_amount(uuid, date)
  TO authenticated;
