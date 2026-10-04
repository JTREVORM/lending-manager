-- ===========================================================================
-- Phase 7 — delinquency and penalty capabilities.
--
-- ## Two capabilities, both read-only
--
-- Phase 7 adds no capability that writes anything, because nothing in it is
-- written by a person. Arrears are derived from the schedule and the ledger;
-- the penalty is calculated and materialised by a trusted function from the
-- loan's own snapshotted terms. There is deliberately no
-- `penalties:create`, no `penalties:edit`, no `penalties:waive` and no
-- `delinquency:edit` — a capability that does not exist cannot be granted by
-- mistake, which is the same argument Phases 5 and 6 made about schedule and
-- payment editing.
--
-- A penalty amount a staff member could type would not be a penalty. It would
-- be a charge, and the business rule says 50% of what the borrower owed when
-- the grace period ran out — a figure only the ledger knows.
--
-- ## Why delinquency and penalties are separate capabilities
--
-- They answer different questions and have different sensitivity.
--
-- `delinquency:view` is the collections view: who is behind, by how much, and
-- since when. It is the working tool of the people who chase payments, so
-- every staff role holds it.
--
-- `penalties:view` is a charge against a borrower's account. It happens to go
-- to the same three roles today, but it is the kind of figure a business may
-- later want to restrict — and separating them now costs one row, while
-- separating them later means finding every screen that conflated the two.
--
-- ## The borrower
--
-- `client` holds neither. A borrower sees their own arrears and their own
-- penalty through the ownership clauses in the Row Level Security policies,
-- never through a capability — the arrangement Phases 4, 5 and 6 established.
-- Capabilities answer "may this member of staff see other people's records";
-- for a borrower's own record the answer is a policy, not a grant.
-- ===========================================================================

insert into public.permissions (key, description)
values
  ('delinquency:view',
   'See arrears, missed collections and the overdue list across loans.'),
  ('penalties:view',
   'See a loan''s expiry penalty: its basis, rate, amount and what remains.')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_key, permission_key)
values
  -- Chasing collections is the counter role's daily work.
  ('secretary_treasurer', 'delinquency:view'),
  ('secretary_treasurer', 'penalties:view'),

  ('manager', 'delinquency:view'),
  ('manager', 'penalties:view'),

  ('owner_admin', 'delinquency:view'),
  ('owner_admin', 'penalties:view')
on conflict (role_key, permission_key) do nothing;
