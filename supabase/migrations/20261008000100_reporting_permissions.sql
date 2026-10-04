-- ===========================================================================
-- Phase 8 — reporting capabilities.
--
-- ## Why three capabilities and not one `reports:view`
--
-- One capability would mean that the person who counts cash over the counter
-- and the person who owns the business see the same screens. They should not.
-- A Secretary/Treasurer needs today's collection sheet and the arrears list to
-- do their job; they do not need the portfolio's total interest income, and a
-- single `reports:view` would hand it to them the moment the first financial
-- report shipped behind it.
--
-- So reporting is split by *what the figures reveal*, not by which screen they
-- appear on:
--
--   * `reports:view_operational` — the daily working reports. Collections for
--     a date range, who is due today, who is behind, which loans are in grace.
--     Per-client and per-loan figures the holder already sees elsewhere, just
--     arranged for a day's work. Every staff role.
--
--   * `reports:view_financial` — portfolio-wide figures. Total outstanding
--     across every borrower, penalties assessed across the book, the cleared
--     and active loan registers with their totals. The information needed to
--     supervise lending, which is the Manager's job and the Owner's.
--
--   * `reports:view_sensitive` — what the business earns and holds. Interest
--     collected, penalty collected, total principal disbursed, the executive
--     summary. Owner/Administrator alone.
--
-- ## These do not replace the underlying capabilities
--
-- A report is a rendering of data the holder must already be entitled to.
-- `reports:view_operational` on its own shows nothing: the arrears report also
-- needs `delinquency:view`, the collection report also needs `payments:view`,
-- and Row Level Security decides which rows come back regardless of either.
-- The reporting capability answers "may this person open the reporting
-- surface", and the existing capabilities and policies answer "and what is in
-- it" — which is why adding these three widens nobody's access to a row they
-- could not already read one at a time.
--
-- ## No write capability, again
--
-- Phase 8 is a reading phase. There is no `reports:create`, no
-- `reports:schedule`, no `reports:export` separate from viewing — a holder who
-- may read a report may take the CSV of exactly the rows that report showed
-- them, because a denial there would be a denial of copy-and-paste rather than
-- a security control. What export does need is the same permission check on
-- the server, which the route handlers perform.
--
-- ## The borrower holds none of them
--
-- A borrower's own statement is not a report. It is their account, reached
-- through `portal:view` and the ownership clauses in the policies, and it
-- shows one person's loans by construction. Granting a reporting capability to
-- `client` would mean the reporting *surface* was reachable by a borrower,
-- which is a different and worse thing than a borrower reading their own rows.
-- ===========================================================================

insert into public.permissions (key, description)
values
  ('reports:view_operational',
   'Open the operational reports: collections, today''s list, arrears and grace.'),
  ('reports:view_financial',
   'Open portfolio-wide reports: the loan register, cleared loans and penalties.'),
  ('reports:view_sensitive',
   'Open the executive summary: interest and penalty collected, principal disbursed.')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_key, permission_key)
values
  -- The counter role works from the collection sheet and the arrears list all
  -- day. Deliberately nothing beyond: see §42 of the specification, and the
  -- reasoning above about what portfolio figures reveal.
  ('secretary_treasurer', 'reports:view_operational'),

  -- The Manager supervises lending, which is not possible without seeing the
  -- book: what is outstanding, what is late, what has been charged. Still not
  -- `reports:view_sensitive` — what the business earns is the Owner's figure,
  -- and a Manager does not need it to chase a payment or approve a loan.
  ('manager', 'reports:view_operational'),
  ('manager', 'reports:view_financial'),

  ('owner_admin', 'reports:view_operational'),
  ('owner_admin', 'reports:view_financial'),
  ('owner_admin', 'reports:view_sensitive')
on conflict (role_key, permission_key) do nothing;
