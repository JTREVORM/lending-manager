-- ===========================================================================
-- Polytos business-policy update — the capabilities this update needs
-- ===========================================================================
--
-- Six, and the test for each is the same one Phase 4 used: would granting it
-- to somebody who already holds the nearest existing capability let them do
-- something the business would want a second person for?
--
-- ## Why a policy transition is its own capability
--
-- `settings:update` already exists and `membership:create` already exists, and
-- neither is the right home. Moving the existing book onto a new policy
-- version changes the terms thousands of members are held to — the monthly
-- minimum their savings are judged against, the multiple of savings they may
-- borrow, whether a benefit is payable at all. It is the single most
-- consequential act in the system and it is not a setting.
--
-- ## Why the meeting fine is three capabilities and not one
--
-- A fine is money. The person who marks a member absent must not be the
-- person who decides that absence costs UGX 5,000, and neither should be the
-- person who can make the charge disappear. That is the same separation the
-- benefit module enforces between assessing, approving and paying, for the
-- same reason, and it is the whole reason a fine is auditable at all.
--
-- `meetings:manage` already covers recording an advance apology — a member
-- rang in and somebody wrote it down, which is clerical. **Accepting** that
-- apology is not clerical: it is the decision that removes the charge, so it
-- is its own capability held by somebody who did not take the message.
-- ===========================================================================

insert into public.permissions (key, description)
values
  -- --- The policy itself ---------------------------------------------------
  ('membership_policy:manage',
   'Publish a membership policy version, preview a transition of the existing book onto it, and move members across. The most consequential capability in the system: it changes the terms existing members are held to.'),

  -- --- Meeting excuses -----------------------------------------------------
  ('meetings:excuse_review',
   'Accept or reject a member''s advance notice that they cannot attend a meeting. Accepting one removes a UGX 5,000 charge, so it is not the clerical act of writing the message down.'),

  -- --- Meeting fines -------------------------------------------------------
  ('fines:view',
   'See assessed meeting fines, what is outstanding and what has been collected.'),
  ('fines:assess',
   'Charge a member the meeting absence fine. Never the person who marked the register.'),
  ('fines:collect',
   'Record payment of a meeting fine against cash, mobile money or the bank.'),
  ('fines:reverse',
   'Cancel or reverse a meeting fine that should not have been charged. Always with a reason, never by deletion.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key)
values
  -- --- Secretary/Treasurer -------------------------------------------------
  --
  -- The counter, and the person who marks the register. So: they see fines
  -- and they take the money, because taking money at a counter is their job.
  --
  -- They do **not** assess. Marking a member absent and then charging them
  -- for it is one person deciding both halves of a financial consequence, and
  -- the register is the only evidence the charge rests on. They do not accept
  -- an excuse either, for the same reason — they are usually the person the
  -- member rang.
  ('secretary_treasurer', 'fines:view'),
  ('secretary_treasurer', 'fines:collect'),

  -- --- Manager --------------------------------------------------------------
  --
  -- Reviews the excuses and charges the fines, neither of which they can then
  -- make disappear. A Manager who could reverse their own charge would be a
  -- Manager whose charges nobody could rely on.
  ('manager', 'meetings:excuse_review'),
  ('manager', 'fines:view'),
  ('manager', 'fines:assess'),
  ('manager', 'fines:collect'),

  -- --- Owner/Administrator ---------------------------------------------------
  --
  -- Everything, including the two nobody else holds: moving the book onto a
  -- new policy version, and reversing a charge.
  ('owner_admin', 'membership_policy:manage'),
  ('owner_admin', 'meetings:excuse_review'),
  ('owner_admin', 'fines:view'),
  ('owner_admin', 'fines:assess'),
  ('owner_admin', 'fines:collect'),
  ('owner_admin', 'fines:reverse')
on conflict (role_key, permission_key) do nothing;

-- Preserve references when the sequence grows beyond its minimum padding.
-- PostgreSQL lpad truncates when the requested width is shorter than the input.
create or replace function public.next_reference(p_scope text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_prefix     text;
  v_padding    smallint;
  v_timezone   text;
  v_year       smallint;
  v_next_value bigint;
begin
  select f.prefix, f.padding
    into v_prefix, v_padding
  from public.reference_formats f
  where f.scope = p_scope;

  if v_prefix is null then
    raise exception 'Unknown reference scope: %', p_scope
      using errcode = 'P0001';
  end if;

  -- The business timezone, from the single place it is configured.
  select c.timezone
    into v_timezone
  from public.company_settings c
  where c.id = 1;

  v_timezone := coalesce(nullif(pg_catalog.btrim(v_timezone), ''), 'Africa/Kampala');

  v_year := (pg_catalog.date_part('year', pg_catalog.timezone(v_timezone, pg_catalog.now()))::int % 100)::smallint;

  -- One atomic statement. The row lock on (scope, period_year) serialises
  -- concurrent callers, so no two can receive the same value.
  insert into public.reference_sequences as s (scope, period_year, last_value, updated_at)
  values (p_scope, v_year, 1, pg_catalog.now())
  on conflict (scope, period_year) do update
    set last_value = s.last_value + 1,
        updated_at = pg_catalog.now()
  returning s.last_value into v_next_value;

  return v_prefix
      || pg_catalog.lpad(v_year::text, 2, '0')
      || pg_catalog.lpad(v_next_value::text,
           greatest(v_padding::int, char_length(v_next_value::text)), '0');
end;
$$;
