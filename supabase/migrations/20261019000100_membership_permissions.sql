-- ===========================================================================
-- Polytos Phase 1.1 — membership capabilities and the membership reference
-- scope.
--
-- ## Membership is not a role
--
-- The first decision this migration encodes is a negative one: membership
-- adds **no role**. The four roles — Client, Secretary/Treasurer, Manager,
-- Owner/Administrator — are about what a person may *do to the system*. Being
-- a member is a fact about a *client record*, in the same way that being
-- blacklisted is. A `member` role would mean a borrower whose savings lapse
-- loses their portal login, which is nonsense, and it would give the business
-- two answers to "who is this person".
--
-- So membership is a row in `public.memberships` keyed on `clients.id`, and
-- the capabilities below govern who may read and write that row.
--
-- ## Which capabilities exist, and which deliberately do not
--
-- The matrix's own rule (lib/permissions/permissions.ts) is that a capability
-- nothing enforces is a false assurance. Every capability declared here is
-- enforced by a Row Level Security policy or a column guard in migration
-- 20261019000600, in this phase, whether or not a screen exists for it yet —
-- the database is the boundary, and a policy written now is a policy an
-- attacker meets now.
--
--   * `membership:view`            — the register, a membership record, its
--                                    status history and the published policy
--                                    versions.
--   * `membership:create`          — enrol a client as a member.
--   * `membership:update`          — correct a membership's ordinary details.
--   * `membership:manage_status`   — move a membership between pending,
--                                    active, suspended, withdrawn and
--                                    deceased.
--   * `membership:manage_policies` — publish or approve a membership policy
--                                    version.
--
-- Deliberately **not** declared: `membership:view_sensitive`. The Phase 1
-- schema holds no personal data beyond what `clients` already holds behind
-- `clients:view` and `client_identities` behind `clients:view_nin`. The
-- sensitive membership data the programme implies — a next of kin, a
-- beneficiary's contact details, a hospital bill on a benefit claim — arrives
-- with the beneficiary and claims tables in Polytos Phase 4, and the
-- capability arrives with them, enforcing something. Declaring it now would
-- promise a restriction that guards nothing.
--
-- ## Why the Secretary/Treasurer reads but does not enrol
--
-- The same reasoning that withholds `clients:create` from them. Enrolling a
-- member mints a membership number, binds the business to a benefits
-- programme, and starts a savings qualification clock — it is the membership
-- analogue of registering a client, which the matrix already treats as a
-- Manager's act. They hold `membership:view` because they will be the people
-- taking savings over the counter from Polytos Phase 2 onwards, and they
-- cannot do that without being able to look a member up.
--
-- `membership:manage_policies` is the Owner's alone, for exactly the reason
-- `settings:update` and `guarantor_terms:manage` are: it sets the
-- registration fee, the savings minimum, the interest rule and the benefit
-- amounts. A Manager who could change those could change what the business
-- charges and what it owes without asking anybody.
-- ===========================================================================

insert into public.permissions (key, description)
values
  ('membership:view',
   'See the membership register, a membership record and the published membership policy.'),
  ('membership:create',
   'Enrol an existing client as a member.'),
  ('membership:update',
   'Correct a membership''s ordinary details.'),
  ('membership:manage_status',
   'Move a membership between pending, active, suspended, withdrawn and deceased.'),
  ('membership:manage_policies',
   'Publish or approve a version of the membership policy.')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_key, permission_key)
values
  -- Reads only. The counter looks a member up; it does not enrol one.
  ('secretary_treasurer', 'membership:view'),

  -- Runs membership operations, as it runs lending operations. Not
  -- `membership:manage_policies`: see the note above.
  ('manager', 'membership:view'),
  ('manager', 'membership:create'),
  ('manager', 'membership:update'),
  ('manager', 'membership:manage_status'),

  ('owner_admin', 'membership:view'),
  ('owner_admin', 'membership:create'),
  ('owner_admin', 'membership:update'),
  ('owner_admin', 'membership:manage_status'),
  ('owner_admin', 'membership:manage_policies')
on conflict (role_key, permission_key) do nothing;

-- A borrower holds none of these. They read their own membership the same way
-- they read their own client record: through the identity clause in the
-- policy on `public.memberships`, which is keyed on `clients.profile_id` and
-- grants exactly one row. Granting `membership:view` to `client` would mean
-- granting the whole register, which is what that capability means everywhere
-- else.

-- ---------------------------------------------------------------------------
-- The membership reference scope
--
-- `MB260001`, minted by `public.next_reference('membership')` inside a BEFORE
-- INSERT trigger, exactly as `CL`, `LN` and `PAY` are. Padding of 4 matches
-- loans and payments rather than clients: a membership number is quoted on a
-- card and in a meeting register, and widening it later would mean two
-- different shapes in circulation.
-- ---------------------------------------------------------------------------

insert into public.reference_formats (scope, prefix, padding, description)
values ('membership', 'MB', 4, 'Membership numbers, e.g. MB260001')
on conflict (scope) do nothing;
