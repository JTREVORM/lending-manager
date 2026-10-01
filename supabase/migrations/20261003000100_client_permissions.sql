-- ===========================================================================
-- Phase 3 — capabilities for client and guarantor management.
--
-- Mirrors the TypeScript matrix in `lib/permissions/permissions.ts`. The two
-- representations exist because they serve different layers: TypeScript decides
-- whether a control renders and whether a Server Action proceeds, while the
-- database decides what a token can actually reach. A test compares them
-- row-for-row, so they cannot drift.
--
-- Two grants are deliberately narrower than a reading of "the Manager runs
-- lending operations" would suggest, and both are commercial decisions rather
-- than technical ones:
--
--   `clients:blacklist` is Owner-only. Blacklisting is the business
--   permanently refusing to lend to someone; it is the one client status that
--   is a standing commercial judgement rather than an operational state, and
--   it should carry an Owner's name.
--
--   `clients:link_auth` is Owner-only. Linking a client record to a login
--   decides who can sign in and see that client's data. It is the same class
--   of act as creating a staff account, which is already Owner-only.
--
-- ## A note on naming
--
-- The specification suggests `clients:remarks:view`. The key format established
-- in Phase 1 is strictly `resource:action` with a single colon — a constraint
-- on `public.permissions`, and a deliberate choice recorded there: a resource
-- never contains a colon, so one colon always separates the two halves
-- unambiguously. Rather than widen a Phase 2 constraint to accommodate a
-- suggested spelling, the capabilities are named `clients:remarks_view`,
-- `clients:remarks_create`, `clients:view_nin` and `guarantors:view_nin`. The
-- grants are identical; only the spelling differs.
--
-- `clients:view_nin` exists because a National Identification Number is the
-- most sensitive field in the system — it is reusable identity evidence, not
-- merely contact data. It is held by Manager and Owner, and enforced by
-- putting the number in its own table with its own policy rather than by
-- hiding it in the interface. See migration 20261003000200.
-- ===========================================================================

insert into public.permissions (key, description)
values
  -- --- Clients -------------------------------------------------------------
  ('clients:view',            'See the client directory, search clients, and open a client record.'),
  ('clients:create',          'Register a new client.'),
  ('clients:update',          'Change a client''s ordinary details.'),
  ('clients:status',          'Move a client between active, inactive and suspended.'),
  ('clients:blacklist',       'Blacklist a client, or lift a blacklisting.'),
  ('clients:archive',         'Archive a client record, which replaces deletion.'),
  ('clients:documents',       'Upload or replace a client''s photograph and identity document.'),
  ('clients:view_nin',        'Read a client''s National Identification Number and identity document.'),
  ('clients:link_auth',       'Link or unlink a client record and a portal login.'),

  -- --- Client remarks ------------------------------------------------------
  ('clients:remarks_view',    'Read internal staff remarks on a client.'),
  ('clients:remarks_create',  'Add an internal staff remark to a client.'),

  -- --- Guarantors ----------------------------------------------------------
  ('guarantors:view',         'See the guarantor directory and open a guarantor record.'),
  ('guarantors:create',       'Register a new guarantor.'),
  ('guarantors:update',       'Change a guarantor''s details.'),
  ('guarantors:documents',    'Upload or replace a guarantor''s photograph.'),
  ('guarantors:view_nin',     'Read a guarantor''s National Identification Number.'),
  ('guarantors:link',         'Attach a guarantor to a client, or detach one.')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_key, permission_key)
values
  -- --- client --------------------------------------------------------------
  -- Nothing. A borrower reads their own client record through the self-clause
  -- in the RLS policy, which is keyed on their profile rather than on a
  -- capability. Granting `clients:view` here would hand them the whole
  -- directory, because that is what the capability means everywhere else.

  -- --- secretary_treasurer -------------------------------------------------
  -- Operational work: find a client, check their details, correct a phone
  -- number, read the remarks left for them to act on.
  --
  -- Deliberately absent: `clients:create` (registration is a Manager act, and
  -- it mints a client number), every status capability, `clients:view_nin`,
  -- `clients:link_auth`, and `clients:remarks_create` — the specification
  -- asks for that last one to be a decision rather than an inheritance, and
  -- the decision is no: a Secretary records payments, and a remark that
  -- carries operational weight should carry a Manager's name.
  ('secretary_treasurer', 'clients:view'),
  ('secretary_treasurer', 'clients:update'),
  ('secretary_treasurer', 'clients:remarks_view'),
  ('secretary_treasurer', 'guarantors:view'),

  -- --- manager -------------------------------------------------------------
  ('manager', 'clients:view'),
  ('manager', 'clients:create'),
  ('manager', 'clients:update'),
  ('manager', 'clients:status'),
  ('manager', 'clients:documents'),
  ('manager', 'clients:view_nin'),
  ('manager', 'clients:remarks_view'),
  ('manager', 'clients:remarks_create'),
  ('manager', 'guarantors:view'),
  ('manager', 'guarantors:create'),
  ('manager', 'guarantors:update'),
  ('manager', 'guarantors:documents'),
  ('manager', 'guarantors:view_nin'),
  ('manager', 'guarantors:link'),

  -- --- owner_admin ---------------------------------------------------------
  ('owner_admin', 'clients:view'),
  ('owner_admin', 'clients:create'),
  ('owner_admin', 'clients:update'),
  ('owner_admin', 'clients:status'),
  ('owner_admin', 'clients:blacklist'),
  ('owner_admin', 'clients:archive'),
  ('owner_admin', 'clients:documents'),
  ('owner_admin', 'clients:view_nin'),
  ('owner_admin', 'clients:link_auth'),
  ('owner_admin', 'clients:remarks_view'),
  ('owner_admin', 'clients:remarks_create'),
  ('owner_admin', 'guarantors:view'),
  ('owner_admin', 'guarantors:create'),
  ('owner_admin', 'guarantors:update'),
  ('owner_admin', 'guarantors:documents'),
  ('owner_admin', 'guarantors:view_nin'),
  ('owner_admin', 'guarantors:link')
on conflict (role_key, permission_key) do nothing;
