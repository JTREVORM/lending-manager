-- ===========================================================================
-- 20261001000700_storage_buckets
--
-- Supabase Storage foundation.
--
-- ## Buckets
--
--   client-documents     National ID photographs, client portraits, signed
--                        loan paperwork. PRIVATE.
--   guarantor-documents   The same, for guarantors. PRIVATE. Separate from
--                        client documents because the two have different
--                        consent and retention positions — a guarantor
--                        consented to back a loan, not to be a customer.
--   company-assets       The company logo and receipt artwork. PRIVATE.
--
-- ## Everything is private, including the logo
--
-- Client and guarantor documents are self-evidently confidential: a public
-- bucket holding a National ID photograph is a data breach waiting for a
-- crawler. Less obviously, the logo bucket is private too. A public bucket is
-- enumerable by anyone who learns the project URL, and the convenience it
-- buys — one fewer signed URL — is not worth a second posture to reason
-- about. Delivery is via a short-lived signed URL created server-side.
--
-- If the business later wants a genuinely public logo (an emailed receipt, for
-- instance), that is a deliberate change to one bucket, made knowingly.
--
-- ## Path convention
--
--   client-documents/<profile_id>/<document_type>/<uuid>.<ext>
--   guarantor-documents/<guarantor_id>/<document_type>/<uuid>.<ext>
--   company-assets/logo/<uuid>.<ext>
--
-- Leading with the owner's id is what makes a Phase 2 RLS policy expressible:
-- "the first path segment must equal the caller's profile id" is a cheap,
-- reliable ownership check. The filename is a fresh uuid rather than the
-- uploaded name, so a client cannot choose a path, cannot collide with
-- another, and cannot smuggle a traversal sequence or a misleading extension.
--
-- ## Size and type limits
--
-- 10 MB for identity documents — generous for a phone photograph, small
-- enough to bound abuse. 2 MB for company assets.
--
-- SVG is deliberately excluded. An SVG is executable XML, and serving one
-- from the project's origin — even through a signed URL — is a stored-XSS
-- vector. Raster formats and PDF only.
--
-- ## Access control
--
-- `storage.objects` has RLS enabled by Supabase with no policies of our own,
-- which denies all access to `anon` and `authenticated`. No bucket is
-- readable or writable from a browser in Phase 1.
--
-- DEFERRED TO PHASE 2 — intentionally absent:
--   * "a client may read their own documents"      (path prefix = profile id)
--   * "staff may read and write client documents"  (user_has_at_least_role)
--   * "owner_admin may manage company assets"
-- Upload workflows arrive with the registration screens that need them.
-- ===========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  (
    'client-documents',
    'client-documents',
    false,
    10485760, -- 10 MiB
    array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']
  ),
  (
    'guarantor-documents',
    'guarantor-documents',
    false,
    10485760, -- 10 MiB
    array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']
  ),
  (
    'company-assets',
    'company-assets',
    false,
    2097152, -- 2 MiB
    array['image/jpeg', 'image/png', 'image/webp']
  )
on conflict (id) do nothing;
