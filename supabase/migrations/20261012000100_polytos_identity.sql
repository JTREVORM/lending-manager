-- ===========================================================================
-- Phase 12.1 — the real company
--
-- Up to here the system has carried a placeholder: `company_settings` was
-- seeded with the software's own name because the client's registration was
-- still in progress. It is no longer. This migration replaces the placeholder
-- with Polytos Financial Services Ltd and adds the three fields the real
-- identity needs that the table did not have.
--
-- ## Why three columns rather than one "contact details" blob
--
-- A tagline is rendered beside the name; a second phone is dialled; a postal
-- address is printed on a letter. Each is used in a different place by
-- different code, and a JSON blob would mean every one of those places
-- parsing it and deciding what to do when a key is missing.
--
-- ## Why the public view widens
--
-- `company_identity` is the one SECURITY DEFINER view in the schema: it hands
-- every signed-in user, borrowers included, the company's own name and
-- branding, because a borrower's receipt has to say who issued it. Phase 9
-- kept it to six columns and the reason given was that registration and tax
-- numbers must stay behind `settings:view`.
--
-- That reasoning is unchanged and the registration and tax numbers are still
-- behind it. What widens is the set of *published* details — the tagline, the
-- two phone numbers, the postal and physical address — which are on the
-- company's own flyer and belong on the documents it issues. A receipt that
-- cannot print the lender's phone number is not a receipt anybody can act on.
-- ===========================================================================

alter table public.company_settings
  add column tagline text,
  add column phone_secondary text,
  add column postal_address text;

comment on column public.company_settings.tagline is
  'Phase 12. The line that sits under the company name on a document or the sign-in screen.';
comment on column public.company_settings.phone_secondary is
  'Phase 12. A second published number. Separate from `phone` rather than a list, because each is dialled from a different place in the product.';
comment on column public.company_settings.postal_address is
  'Phase 12. The P.O. Box, which is not the physical address and is the one a letter goes to.';

-- The same E.164 shape the primary number carries, so one number cannot be
-- stored in a format the other refuses.
alter table public.company_settings add constraint company_settings_phone_secondary_e164
  check (phone_secondary is null or phone_secondary ~ '^\+256[0-9]{9}$');

alter table public.company_settings add constraint company_settings_tagline_length
  check (tagline is null or char_length(btrim(tagline)) between 2 and 160);

-- ---------------------------------------------------------------------------
-- Polytos Financial Services Ltd
--
-- Written as an UPDATE of the singleton rather than an INSERT, because the
-- row has existed since migration 20261001000800 and a loan, a payment and a
-- receipt all already point at the business it describes.
-- ---------------------------------------------------------------------------

update public.company_settings
   set company_name = 'Polytos Financial Services Ltd',
       legal_name = 'Polytos Financial Services Limited',
       tagline = 'Empowering Your Business Swiftly',
       phone = '+256768735982',
       phone_secondary = '+256703587676',
       postal_address = 'P.O. Box 219933, Kampala',
       address_line1 = 'Nsumbi, Kyebando',
       city = 'Kampala',
       country = 'Uganda',
       -- A path under the application's public asset root, which is what the
       -- existing CHECK already describes: no leading slash, no `..`. The
       -- supplied asset ships with the build rather than being uploaded,
       -- because it is the company's mark and not a per-tenant setting.
       logo_path = 'brand/polytos-logo.webp',
       receipt_header = 'Polytos Financial Services Ltd',
       receipt_footer =
         'Thank you for your business. Keep this receipt as proof of payment.'
 where id = 1;

-- ---------------------------------------------------------------------------
-- The public identity view
--
-- Replaced in place rather than dropped and recreated. `create or replace
-- view` may only *append* columns, which is why the eight new ones sit at the
-- end instead of beside the name they belong with: the alternative is a DROP,
-- and dropping a view every signed-in session reads — on a live database,
-- mid-request — to improve the column order of a result nobody reads
-- positionally is not a trade worth making.
-- ---------------------------------------------------------------------------

create or replace view public.company_identity
with (security_invoker = off)
as
select
  -- The Phase 9 six, unchanged and in their original order.
  c.company_name,
  c.currency_code,
  c.locale,
  c.timezone,
  c.logo_path,
  c.brand_primary_color,
  -- Phase 12. The tagline and the published contact details: on the flyer,
  -- on the receipt, on the letter.
  c.tagline,
  c.phone,
  c.phone_secondary,
  c.postal_address,
  c.address_line1,
  c.address_line2,
  c.city,
  c.country
from public.company_settings c
where c.id = 1;

comment on view public.company_identity is
  'Phase 9, widened in Phase 12. The company''s own published identity, readable by every signed-in user including borrowers, because a receipt has to say who issued it. The registration and tax numbers are deliberately absent and stay behind settings:view.';

-- Re-stated because `create or replace view` leaves the existing grants
-- alone and Supabase's ALTER DEFAULT PRIVILEGES would otherwise be the only
-- thing that decided them.
revoke all on table public.company_identity from anon, authenticated;
grant select on table public.company_identity to authenticated;
