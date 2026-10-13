-- ===========================================================================
-- 20261017000100_settings_reference_sequences
--
-- A safe read surface for the Settings screen's reference-numbering section.
--
-- ## The mismatch this closes
--
-- `reference_formats` and `reference_sequences` are deliberately default-deny:
-- RLS is on, the table grants are revoked from `anon` and `authenticated`,
-- and no policy exists — because the counters disclose how many clients and
-- loans the business has, which is commercially sensitive and which nothing
-- was ever meant to read from a session (see
-- `20261002000500_settings_and_audit_rls.sql`).
--
-- Phase 12's Settings screen then read `reference_sequences` directly from the
-- caller's session. Against a revoked grant that is not an empty result — it
-- is `42501 insufficient_privilege`, raised before any policy is consulted —
-- so `getSettingsSnapshot()` recorded the read as unavailable and every Owner
-- saw the yellow "Some settings could not be read" banner, on a table the
-- security model says they must not read directly.
--
-- ## The fix, without weakening the model
--
-- The table stays exactly as locked as it was: no new table grant, no policy,
-- still unreadable to an ordinary `authenticated` table read. Instead this
-- adds one `SECURITY DEFINER` function that reads the table on the caller's
-- behalf and returns only the three fields the screen shows — scope, the
-- two-digit period year, and the last value issued. It is gated on
-- `settings:view`, the same capability the screen and the `company_settings`
-- row already require, so the surface a caller reaches through it is no wider
-- than the page they reached it from.
--
-- What it deliberately does NOT expose: `reference_formats` (the prefix and
-- padding are internal), `created_at`/`updated_at`, and any ability to write.
-- A caller still cannot rewind a counter, because the table's write path
-- remains `next_reference()` alone.
-- ===========================================================================

create or replace function public.settings_reference_sequences()
returns table (
  scope text,
  period_year smallint,
  last_value bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- The gate. `settings:view` is the capability that opens the Settings
  -- screen and the company record; the reference counters belong to the same
  -- surface, so they take the same key rather than a looser one. A caller
  -- without it — a borrower, or a staff role that does not administer the
  -- business — is refused with the same code the bare table would raise, so
  -- the function discloses no more than the table it fronts.
  if not public.user_has_permission('settings:view') then
    raise exception 'permission denied for reference sequences'
      using errcode = '42501';
  end if;

  return query
    select s.scope, s.period_year, s.last_value
    from public.reference_sequences s
    order by s.scope asc, s.period_year desc;
end;
$$;

comment on function public.settings_reference_sequences() is
  'Phase 18. The Settings screen''s read-only view of reference numbering: scope, period year and last value, gated on settings:view. SECURITY DEFINER so the counters stay unreadable to a direct table read — the table''s own grants remain revoked from authenticated.';

-- EXECUTE, not table access. Revoke the inherited default first so the grant
-- below is the whole story, the way `user_has_permission` is granted.
revoke all on function public.settings_reference_sequences() from public, anon, authenticated;
grant execute on function public.settings_reference_sequences() to authenticated;
