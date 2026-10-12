-- ===========================================================================
-- Phase 12.5 — the guard rail holds in both directions
--
-- 12.2 made `business_settings` the guard rail: a product that tried to lend
-- more than the business permits, or at a rate above its ceiling, is refused
-- by `loan_products_within_business_rules` when the product is saved.
--
-- That is only half of it. The trigger fires on the *product*, so lowering
-- the business maximum from 20,000,000 to 5,000,000 was accepted without
-- complaint and left four products quietly offering more than the business
-- permits. The rail would then exist only for products saved afterwards —
-- which is precisely the "two conflicting sources of truth" the precedence
-- note at the head of 20261012000200 says must not happen.
--
-- So the same rule is enforced from the other side: a change to
-- `business_settings` that would strand an active product is refused, and the
-- refusal names the product and the limit. The Owner then has a real choice —
-- reprice the product, or withdraw it — rather than a configuration that
-- silently disagrees with itself.
--
-- ## Why only active products
--
-- A withdrawn product cannot be chosen for a new application, so it cannot
-- lend anything. `IL-LEGACY` carries exactly the terms of the 33 agreements
-- the business made before it had named products; if a future business
-- decision narrows the range those sat in, the withdrawn product must not
-- block it, and its loans are untouched either way.
--
-- ## Why this is a trigger and not a check in the application
--
-- Both sides of the rail have to hold for anything that connects to the
-- database, not only for the settings screen. A rule that lives in a form is
-- not a rule.
-- ===========================================================================

create or replace function public.business_settings_keep_products_valid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  p record;
begin
  for p in
    select * from public.loan_products where status = 'active' order by sort_order, name
  loop
    if p.min_amount < new.min_loan_amount then
      raise exception
        '% lends from % , which is below the new business minimum of %. Reprice or withdraw the product first.',
        p.name, p.min_amount, new.min_loan_amount using errcode = 'P0001';
    end if;

    if p.max_amount > new.max_loan_amount then
      raise exception
        '% lends up to %, which is above the new business maximum of %. Reprice or withdraw the product first.',
        p.name, p.max_amount, new.max_loan_amount using errcode = 'P0001';
    end if;

    if p.max_interest_rate_bps > new.default_monthly_interest_rate_bps * 2 then
      raise exception
        '%''s rate ceiling of % bp is more than twice the new business rate of % bp. Reprice or withdraw the product first.',
        p.name, p.max_interest_rate_bps, new.default_monthly_interest_rate_bps
        using errcode = 'P0001';
    end if;

    if p.min_term_months < new.min_loan_term_months then
      raise exception
        '% runs from % months, which is shorter than the new business minimum of %. Reprice or withdraw the product first.',
        p.name, p.min_term_months, new.min_loan_term_months using errcode = 'P0001';
    end if;

    if p.max_term_months > new.max_loan_term_months then
      raise exception
        '% runs to % months, which is longer than the new business maximum of %. Reprice or withdraw the product first.',
        p.name, p.max_term_months, new.max_loan_term_months using errcode = 'P0001';
    end if;
  end loop;

  return new;
end;
$$;

comment on function public.business_settings_keep_products_valid() is
  'Phase 12. Refuses a change to business_settings that would leave an active loan product outside the bounds it is supposed to be inside. The other half of loan_products_within_business_rules.';

revoke all on function public.business_settings_keep_products_valid() from public, anon, authenticated;

create trigger business_settings_keep_products_valid
  before update on public.business_settings
  for each row execute function public.business_settings_keep_products_valid();
