-- ===========================================================================
-- Polytos business-policy update — the qualification engine reads the
-- governing version, and judges each month by the terms of that month
-- ===========================================================================
--
-- The previous two migrations built the pieces. This one joins them:
-- `member_savings_qualification` stops reading the version frozen on the
-- account and starts reading the version that **governs** it on the date
-- being asked about.
--
-- Two different things change, and keeping them apart is the point:
--
--   - **The rule** — how many qualifying months are required, and whether
--     they must be consecutive — comes from the version governing the member
--     *now*. Those are the terms they are currently held to, and a member who
--     has accepted new terms is judged by them.
--
--   - **The bar for each month** — the monthly minimum a contribution had to
--     clear — comes from the version that governed the member *in that
--     month*. A January deposit of UGX 50,000 cleared January's bar, and no
--     later transition can make it not have done.
--
-- That split is the whole safety property. Without it, moving a member onto a
-- version with a higher minimum would reach back over every month they ever
-- saved and silently take months away from them — which is the failure the
-- brief names in §4, and which no amount of care at the transition itself
-- would prevent.
--
-- The rule itself changing is **not** hidden, and is not meant to be. If a new
-- version required eight months where the old one required six, a
-- transitioned member would be short two, and that is a real consequence of
-- the terms they accepted. `preview_membership_policy_transition` exists to
-- put exactly that in front of whoever authorises the move, before anybody is
-- moved: `qualifies_before` and `qualifies_after`, member by member.
--
-- For the policy version this update prepares, the minimum and the month count
-- are both unchanged from 1.0 — UGX 50,000 and six — so no member's
-- qualification moves at all. The machinery is still correct rather than
-- merely lucky, and `tests/db/policy-transition.test.ts` proves it against a
-- version where the figures do differ.
-- ===========================================================================

create or replace function public.member_savings_qualification(
  p_savings_account_id uuid,
  p_as_of date default null
)
returns table (
  savings_account_id uuid,
  as_of date,
  monthly_minimum bigint,
  months_required smallint,
  must_be_consecutive boolean,
  qualifying_months integer,
  longest_consecutive_months integer,
  months_recorded integer,
  months_short integer,
  total_contributed bigint,
  total_withdrawn bigint,
  balance bigint,
  qualifies boolean,
  blocked_reason text
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_version uuid;
begin
  -- The version governing this account on the date being asked about, which
  -- is the account's own frozen version until a transition moves the
  -- membership — so every account that has never been transitioned gets
  -- exactly the answer it got before this migration.
  v_version := public.savings_account_governing_policy(
    p_savings_account_id, p_as_of);

  if v_version is null then
    raise exception 'No such savings account.' using errcode = 'P0001';
  end if;

  return query
  select * from public.savings_qualification_under_policy(
    p_savings_account_id, v_version, p_as_of,
    -- Each month against the terms of that month.
    true);
end;
$$;

comment on function public.member_savings_qualification(uuid, date) is
  'Polytos Phase 2, rewired by the policy update. Whether a savings account has met the qualifying-month rule as of a date. The rule — how many months, and whether consecutive — comes from the version governing the member on that date; the monthly minimum each contribution had to clear comes from the version that governed them in that month. A transition therefore cannot take away a month already saved.';
