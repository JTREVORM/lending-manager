-- ===========================================================================
-- Close the loan-validation disclosure, without restating the approval rules.
--
-- ## The finding
--
-- `public.validate_loan_for_approval(uuid)` is SECURITY DEFINER and was
-- granted to `authenticated` with no authorization check of its own. Any
-- active identity that knows a loan's UUID could therefore read back that
-- loan's approval assessment: the client's status, how many active loans they
-- hold, the business amount and term thresholds, the member's savings
-- qualification progress, their maximum eligible loan, and the guarantor
-- counts and completeness. A borrower holds no loan capability at all, so none
-- of that is theirs to see.
--
-- Recorded as a residual in 20261103000100 rather than fixed there, for a
-- stated reason that was correct: guarding it in place means restating a
-- two-hundred-line approval body in a new migration, and a transcription slip
-- in a loan-approval rule is a worse outcome than the disclosure it closes.
--
-- ## Why this migration does not restate anything
--
-- `ALTER FUNCTION ... RENAME TO` moves the existing function, body and all,
-- byte for byte. Nothing is retyped, so there is nothing to mistype. The
-- approval calculation that ships today is the approval calculation that ships
-- after this migration; only the door in front of it changes.
--
-- The renamed function then loses its `authenticated` grant, which is what
-- takes it off the Data API: PostgREST can only reach what the request's role
-- may execute. It keeps `postgres` and `service_role`, so the five internal
-- call sites — all of them inside `public.approve_loan`, which runs SECURITY
-- DEFINER as the owner — are unaffected, and trusted no-JWT maintenance and
-- seed paths keep the behaviour they have. This is the same shape
-- `require_business_identity` already has: privileged, internal, and reachable
-- only from inside another definer function.
--
-- A thin wrapper then takes the original name, signature, volatility and
-- result shape, so every existing caller — `approve_loan`, the application's
-- `loanApprovalFailures`, the generated database types — continues to call
-- `public.validate_loan_for_approval(uuid)` and gets the same rows.
--
-- ## Why `loans:view`, and why that cannot break approval
--
-- Verified against the live capability matrix rather than assumed:
--
--   owner_admin          loans:view ✓   loans:approve ✓
--   manager              loans:view ✓   loans:approve ✓
--   secretary_treasurer  loans:view ✓   loans:approve ✗
--   client (borrower)    loans:view ✗   loans:approve ✗
--
-- Every role that can reach an approval screen holds `loans:view`; the
-- borrower holds no loan capability. And every internal call site sits
-- immediately after `approve_loan`'s own `loans:approve` check, whose two
-- holders both hold `loans:view`. So the guard denies exactly the caller the
-- finding is about and no legitimate one.
--
-- A plain `REVOKE ... FROM authenticated` on the original name was considered
-- and rejected: `lib/data/loans.ts` calls this RPC with the caller's own JWT
-- through `createSupabaseServerClient()`, so revoking the grant would break
-- the loan-approval screen rather than secure it.
--
-- ## What is not touched
--
-- No financial calculation, balance, schedule, journal, penalty or repayment
-- logic. No row is read or written. No other grant, policy, role assignment,
-- account or policy version changes. The function's arguments, defaults,
-- volatility and `TABLE(failure_code text, detail text)` result are identical.
-- ===========================================================================

DO $guard_loan_validation$
BEGIN
  -- Defensive: a replay must not rename a wrapper into the internal slot.
  IF to_regprocedure('public.validate_loan_for_approval_internal(uuid)')
     IS NOT NULL THEN
    RAISE NOTICE
      'public.validate_loan_for_approval_internal already exists; skipping rename';
    RETURN;
  END IF;

  IF to_regprocedure('public.validate_loan_for_approval(uuid)') IS NULL THEN
    RAISE EXCEPTION
      'public.validate_loan_for_approval(uuid) is absent: refusing to guard a function that is not there';
  END IF;

  ALTER FUNCTION public.validate_loan_for_approval(uuid)
    RENAME TO validate_loan_for_approval_internal;
END;
$guard_loan_validation$;

-- Off the Data API. `postgres` (the owner) and `service_role` keep EXECUTE, so
-- internal definer callers and trusted maintenance paths are unchanged.
REVOKE ALL ON FUNCTION public.validate_loan_for_approval_internal(uuid)
  FROM public, anon, authenticated;

COMMENT ON FUNCTION public.validate_loan_for_approval_internal(uuid) IS
  'Every rule a loan must satisfy to be approved, as machine-readable failure codes. Zero rows means approvable. Re-evaluated at approval, never trusted from draft time. INTERNAL as of 20261106000100: deliberately not granted to authenticated, so it is unreachable through the Data API. Call it only from inside another SECURITY DEFINER function that has already checked its own capability, or through public.validate_loan_for_approval(uuid), which checks loans:view.';

-- ---------------------------------------------------------------------------
-- The authorized public wrapper
--
-- Keeps the original name, signature, volatility and result shape. Holds no
-- approval logic of its own, so there is exactly one place where the rules
-- live and this is not it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_loan_for_approval(p_loan_id uuid)
RETURNS TABLE(failure_code text, detail text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
begin
  -- Active account with a completed password change, as of 20261030180224.
  -- Null-returning for trusted no-JWT paths, which is deliberate.
  perform public.require_business_identity();

  -- Reading why a loan cannot be approved is a loan-register read. Borrowers
  -- hold no loan capability. Trusted no-JWT maintenance and seed paths keep
  -- their existing bypass, exactly as `ledger_account_balance` does.
  if (select auth.uid()) is not null
     and not (select public.user_has_permission('loans:view')) then
    raise exception 'Not authorized to read loan approval validation.'
      using errcode = '42501';
  end if;

  return query
    select v.failure_code, v.detail
    from public.validate_loan_for_approval_internal(p_loan_id) v;
end;
$function$;

COMMENT ON FUNCTION public.validate_loan_for_approval(uuid) IS
  'Every rule a loan must satisfy to be approved, as machine-readable failure codes. Zero rows means approvable. As of 20261106000100 this is a thin authorized wrapper: it requires a business identity and the loans:view capability, then delegates unchanged to public.validate_loan_for_approval_internal(uuid), which holds the rules. Do not move approval logic back into this function — the database security gate asserts that the rules stay behind the internal name.';

REVOKE ALL ON FUNCTION public.validate_loan_for_approval(uuid)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_loan_for_approval(uuid) TO authenticated;
