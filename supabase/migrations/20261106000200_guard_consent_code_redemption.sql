-- ===========================================================================
-- Close the consent-attempt exhaustion gap.
--
-- ## The finding
--
-- `public.redeem_membership_consent_code(uuid, text)` is SECURITY DEFINER,
-- VOLATILE, granted to `authenticated`, and checks no capability. Its sibling
-- `public.issue_membership_consent_code(uuid, uuid)` requires
-- `membership:create` or `membership:manage_policies`. So the database would
-- let any active identity — a borrower included — attempt codes against
-- somebody else's challenge, provided they knew its UUID.
--
-- The realistic harm is not code recovery. A six-digit code, a ten-minute
-- window, a one-live-challenge rule and a five-attempt cap put guessing out of
-- reach. The harm is denial: five wrong guesses burn the cap, and the member
-- standing at the counter can no longer consent with the code they were just
-- read. The fix is therefore about who may spend the attempts, not about
-- making the code harder to guess.
--
-- ## The guard
--
-- The same capability pair the issuer requires. Redemption is a counter
-- action: staff read the code back from the member and type it in, which is
-- why `lib/membership/actions.ts` calls this with the staff member's own JWT.
-- Anyone entitled to issue a code to a member is entitled to spend an attempt
-- proving one, and nobody else is.
--
-- Raised with 42501 rather than the function's existing P0001, because this is
-- an authorization refusal and not a wrong code. That distinction matters: a
-- caller must not be able to tell "not allowed" apart from "wrong code" by
-- reading a success, and must be able to tell them apart in a log. The
-- attempts counter is deliberately *not* incremented on an authorization
-- refusal — charging an unauthorized caller's attempt to the member's cap
-- would leave the denial this migration closes wide open.
--
-- Trusted no-JWT callers (service_role, migrations, the bootstrap script, the
-- seeders) keep their existing bypass, for the same reason every other guard
-- in this schema exempts them: they already bypass Row Level Security, and
-- this constrains authenticated sessions.
--
-- ## What is preserved, exactly
--
-- Challenge lookup and `FOR UPDATE` locking, the already-consumed refusal, the
-- expiry refusal, the five-attempt cap, the digest comparison, the
-- attempts increment on a genuinely wrong code, the deliberate non-consumption
-- of the challenge (the acceptance guard consumes it, in the same transaction
-- as the acceptance it proves), the return value, the signature, the
-- volatility and every error code and message on those paths. No row outside
-- `membership_consent_challenges.attempts` is read or written, and no
-- financial record, account, policy version or audit row is touched.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.redeem_membership_consent_code(
  p_challenge_id uuid,
  p_code text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  v_challenge public.membership_consent_challenges%rowtype;
begin
  -- Added 20261106000200. Mirrors issue_membership_consent_code's capability
  -- pair. Checked before the challenge is read, so an unauthorized caller
  -- learns nothing about whether the challenge exists, and spends none of its
  -- attempts. Trusted no-JWT paths are exempt.
  if (select auth.uid()) is not null
     and not (select public.user_has_permission('membership:create'))
     and not (select public.user_has_permission('membership:manage_policies')) then
    raise exception
      'Redeeming a consent code requires the membership:create or membership:manage_policies capability.'
      using errcode = '42501';
  end if;

  select * into v_challenge
  from public.membership_consent_challenges
  where id = p_challenge_id
  for update;

  if not found then
    raise exception 'No such consent challenge.' using errcode = 'P0001';
  end if;

  if v_challenge.consumed_at is not null then
    raise exception 'That code has already been used.' using errcode = 'P0001';
  end if;

  if v_challenge.expires_at <= pg_catalog.now() then
    raise exception 'That code has expired. Send a new one.' using errcode = 'P0001';
  end if;

  if v_challenge.attempts >= 5 then
    raise exception
      'Too many wrong attempts on that code. Send a new one.'
      using errcode = 'P0001';
  end if;

  if v_challenge.code_digest
     is distinct from public.consent_evidence_digest(coalesce(p_code, '')) then
    update public.membership_consent_challenges
       set attempts = attempts + 1
     where id = p_challenge_id;

    raise exception 'That code does not match.' using errcode = 'P0001';
  end if;

  -- Correct. The challenge is *not* consumed here: the acceptance guard
  -- consumes it, in the same transaction as the acceptance it proves, so a
  -- code cannot be burned by a redemption that then fails to record anything.
  return p_challenge_id;
end;
$function$;

COMMENT ON FUNCTION public.redeem_membership_consent_code(uuid, text) IS
  'Polytos Phase 2. Proves a member read back the one-time consent code sent to their phone. Returns the challenge id on a match; the acceptance guard consumes the challenge. As of 20261106000200 it requires membership:create or membership:manage_policies, mirroring the issuer, so an unrelated session cannot exhaust another member''s five attempts. An authorization refusal spends no attempt.';

REVOKE ALL ON FUNCTION public.redeem_membership_consent_code(uuid, text)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.redeem_membership_consent_code(uuid, text)
  TO authenticated;
