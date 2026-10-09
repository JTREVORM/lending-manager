-- ===========================================================================
-- Phase 12.6 — a retired cadence must not freeze every product that offered it
--
-- `loan_products_within_business_rules` checked, on every INSERT and every
-- UPDATE, that each cadence a product offers is an *active* row in
-- `repayment_frequencies`. That is right when the list is being set and wrong
-- afterwards: retire "every 3 days", and from that moment no product that had
-- ever offered it can be saved at all. Changing such a product's rate — a
-- change that does not touch its cadences — was refused with a message about
-- a cadence, and the only way out was to edit a field the Owner had not come
-- to edit.
--
-- So the membership check now runs when the list is actually being set: on
-- INSERT, and on an UPDATE that changes `allowed_repayment_frequencies` or
-- the default. A product left holding a retired cadence is not thereby
-- lending on it — `generate_loan_schedule` reads `repayment_frequencies` and
-- refuses an inactive one, as `tests/db/schedule-generation.test.ts` asserts
-- — so nothing here weakens what can be sold. What it stops is a retired
-- cadence taking the product catalogue hostage.
--
-- Everything else in the function is unchanged, deliberately: the amount,
-- rate and term bounds are re-checked on every write, because
-- `business_settings` is now guarded from the other side too (12.5) and the
-- two halves together are what make the rail real.
-- ===========================================================================

create or replace function public.loan_products_within_business_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  b record;
  v_freq text;
  v_cadences_changed boolean;
begin
  select * into b from public.business_settings where id = 1;

  if b is null then
    raise exception 'Business settings have not been configured.' using errcode = 'P0001';
  end if;

  if new.min_amount < b.min_loan_amount then
    raise exception
      'This product would lend from % but the business minimum is %.',
      new.min_amount, b.min_loan_amount using errcode = 'P0001';
  end if;

  if new.max_amount > b.max_loan_amount then
    raise exception
      'This product would lend up to % but the business maximum is %.',
      new.max_amount, b.max_loan_amount using errcode = 'P0001';
  end if;

  if new.max_interest_rate_bps > b.default_monthly_interest_rate_bps * 2 then
    -- Twice the standing rate, not the standing rate itself: a product may
    -- legitimately price risk above the default, and a ceiling equal to the
    -- default would make every product identical. What this refuses is a
    -- rate nobody intended to type.
    raise exception
      'This product''s ceiling of % bp is more than twice the business rate of % bp.',
      new.max_interest_rate_bps, b.default_monthly_interest_rate_bps
      using errcode = 'P0001';
  end if;

  if new.min_term_months < b.min_loan_term_months then
    raise exception
      'This product would run from % months but the business minimum is %.',
      new.min_term_months, b.min_loan_term_months using errcode = 'P0001';
  end if;

  if new.max_term_months > b.max_loan_term_months then
    raise exception
      'This product would run to % months but the business maximum is %.',
      new.max_term_months, b.max_loan_term_months using errcode = 'P0001';
  end if;

  -- Phase 12.6. Only when the list is being set. See the head of this file.
  v_cadences_changed := tg_op = 'INSERT'
    or new.allowed_repayment_frequencies is distinct from old.allowed_repayment_frequencies
    or new.default_repayment_frequency is distinct from old.default_repayment_frequency;

  if v_cadences_changed then
    foreach v_freq in array new.allowed_repayment_frequencies loop
      if not exists (
        select 1 from public.repayment_frequencies f where f.key = v_freq and f.is_active
      ) then
        raise exception 'There is no active repayment cadence called "%".', v_freq
          using errcode = 'P0001';
      end if;
    end loop;

    if not (new.default_repayment_frequency = any (new.allowed_repayment_frequencies)) then
      raise exception
        'The default cadence "%" is not one this product offers.',
        new.default_repayment_frequency using errcode = 'P0001';
    end if;
  end if;

  -- A named duration menu has to sit inside the product's own bounds.
  if new.allowed_term_months is not null then
    if exists (
      select 1 from pg_catalog.unnest(new.allowed_term_months) as t(months)
      where t.months < new.min_term_months or t.months > new.max_term_months
    ) then
      raise exception
        'A duration option falls outside this product''s own % to % month range.',
        new.min_term_months, new.max_term_months using errcode = 'P0001';
    end if;
  end if;

  -- An override list names roles that exist.
  if pg_catalog.cardinality(new.interest_override_roles) > 0 then
    if exists (
      select 1 from pg_catalog.unnest(new.interest_override_roles) as r(key)
      where not exists (select 1 from public.roles ro where ro.key = r.key)
    ) then
      raise exception 'An override role does not exist.' using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;
