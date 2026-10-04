-- ===========================================================================
-- Phase 9 — the company's identity, readable by everyone who is signed in
--
-- ## The defect this fixes
--
-- `company_settings` is readable only by a caller holding `settings:view`,
-- which the three staff roles hold and `client` does not. That is correct for
-- the row as a whole: it carries the registration number, the tax
-- identification number, the office address and the business email.
--
-- But the application shell reads the *company name* from that row, so a
-- borrower signing in to the portal got the fallback — and the pre-Phase-9
-- screenshots show the borrower's portal headed "Money Lending Management
-- System" while every staff screen said "Kyanja Credit Services". The
-- borrower was shown the name of the software instead of the name of the
-- lender they owe money to.
--
-- The company's own name is not a secret from its own customers. What is
-- sensitive is everything else in that row.
--
-- ## Why a SECURITY DEFINER view, when Phase 8 preferred security_invoker
--
-- Row Level Security decides rows, not columns. There is one row here, so no
-- row-level policy can say "this reader may see the name but not the tax
-- number". A view that selects five columns and runs with the definer's
-- rights is the mechanism that fits the question being asked.
--
-- It is safe because of what it selects, not because of who calls it: there
-- is no sensitive column in the view, no parameter, no row choice, and no
-- borrower or financial data anywhere near it. The remaining Phase 8
-- reporting views stay `security_invoker` — this is the documented exception,
-- not a new default. See ADR-043.
-- ===========================================================================

create or replace view public.company_identity
with (security_invoker = off) as
select
  s.company_name,
  s.currency_code,
  s.locale,
  s.timezone,
  s.logo_path,
  s.brand_primary_color
from public.company_settings as s
where s.id = 1;

comment on view public.company_identity is
  'Phase 9. The company name, locale, timezone, logo and brand colour — the fields the application shell needs to render itself — readable by every signed-in user including borrowers. SECURITY DEFINER by design: RLS cannot restrict columns, and every column here is already public-facing. Registration, tax, address, phone and email stay behind settings:view on company_settings itself.';

-- Supabase's ALTER DEFAULT PRIVILEGES grants broadly in `public`, so the
-- REVOKE has to name both roles before the GRANT means anything.
revoke all on table public.company_identity from anon, authenticated;
grant select on table public.company_identity to authenticated;

-- `anon` is deliberately omitted. The sign-in page renders before there is a
-- session and uses the configured default name; opening this to anonymous
-- callers would let anyone on the internet read the business's branding
-- configuration, which buys nothing.
