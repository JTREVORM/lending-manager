-- ===========================================================================
-- Phase 7 — payments can satisfy a penalty.
--
-- ## The choice: generalise the allocation, or add a second table
--
-- Phase 6's `payment_allocations` points at an installment. A penalty is not
-- an installment, so there were two ways to let money reach it.
--
-- **A second table** (`penalty_payment_allocations`) would leave the
-- contractual allocation schema untouched. It would also duplicate every
-- piece of machinery that makes an allocation trustworthy — the append-only
-- triggers, the per-row component CHECKs, the audit trigger, the policy that
-- delegates visibility to the payment — and it would make the most important
-- question about a payment ("where did this money go?") a union of two
-- tables that could drift apart. Every balance view, every receipt and every
-- reconciliation check would have to remember to look in both places, and
-- the one that forgot would under-report silently.
--
-- **Generalising the target** keeps one answer to that question. The cost is
-- relaxing `installment_id` to nullable, which is only safe with a strict
-- rule about what may then be null — so the rule is explicit:
--
--   * exactly one of `installment_id` and `penalty_id` is set, never both and
--     never neither (`payment_allocations_one_target`);
--   * an installment allocation splits into principal and interest and has no
--     penalty component;
--   * a penalty allocation is entirely penalty, with no principal and no
--     interest.
--
-- The last rule is what keeps Phase 7 honest about classification: a penalty
-- is neither principal nor contractual interest, and the schema refuses to
-- let it be recorded as either. `principal_paid + principal_remaining =
-- contractual_principal` therefore still holds exactly, which is the Phase 6
-- invariant §64 requires to survive.
--
-- ## Existing rows are untouched
--
-- `allocated_penalty` defaults to zero and every existing row has an
-- installment and no penalty, so all three new constraints are satisfied by
-- the Phase 6 data exactly as it stands. No row is rewritten, no receipt
-- changes, and `NOT VALID` is deliberately **not** used: the constraints are
-- validated against the existing rows at migration time, which is the point
-- at which a surprise would be cheap to find.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The target becomes one-of-two
-- ---------------------------------------------------------------------------

alter table public.payment_allocations
  alter column installment_id drop not null;

alter table public.payment_allocations
  add column penalty_id uuid
    references public.loan_penalties (id) on delete restrict;

-- The third component. Zero on every contractual allocation, which is what
-- makes the Phase 6 totals unchanged by this migration.
alter table public.payment_allocations
  add column allocated_penalty bigint not null default 0;

comment on column public.payment_allocations.installment_id is
  'The scheduled collection this money satisfied, or NULL when the target is a penalty. Exactly one target is set.';
comment on column public.payment_allocations.penalty_id is
  'The penalty this money satisfied, or NULL when the target is a scheduled collection.';
comment on column public.payment_allocations.allocated_penalty is
  'The penalty component. Zero on a contractual allocation; the whole amount on a penalty allocation. Never recorded as interest.';

-- ---------------------------------------------------------------------------
-- The rules
-- ---------------------------------------------------------------------------

alter table public.payment_allocations
  add constraint payment_allocations_one_target
    check (
      (installment_id is not null and penalty_id is null)
      or (installment_id is null and penalty_id is not null)
    );

alter table public.payment_allocations
  add constraint payment_allocations_penalty_component_non_negative
    check (allocated_penalty >= 0);

-- An installment allocation has no penalty component; a penalty allocation is
-- nothing but penalty. Stated as one constraint per target so a violation
-- names the case that failed.
alter table public.payment_allocations
  add constraint payment_allocations_installment_components
    check (
      installment_id is null
      or (allocated_penalty = 0
          and allocated_amount = allocated_principal + allocated_interest)
    );

alter table public.payment_allocations
  add constraint payment_allocations_penalty_components
    check (
      penalty_id is null
      or (allocated_principal = 0
          and allocated_interest = 0
          and allocated_penalty = allocated_amount)
    );

-- Phase 6's `payment_allocations_components_sum` said amount = principal +
-- interest for every row, which a penalty allocation cannot satisfy. It is
-- replaced by the two target-specific constraints above — strictly stronger
-- for an installment allocation, because it now also pins the penalty
-- component to zero.
alter table public.payment_allocations
  drop constraint payment_allocations_components_sum;

-- The amount is still the sum of its three components, whichever target it
-- has. Kept as a single whole-row invariant so no future target can introduce
-- money that belongs to no component.
alter table public.payment_allocations
  add constraint payment_allocations_components_sum
    check (allocated_amount = allocated_principal + allocated_interest + allocated_penalty);

-- One allocation per penalty per payment, mirroring the installment rule.
-- A partial unique index rather than a table constraint, because the column
-- is nullable and two NULLs are not equal: without the WHERE clause, the
-- constraint would be no constraint at all on contractual rows.
create unique index payment_allocations_unique_penalty_per_payment
  on public.payment_allocations (payment_id, penalty_id)
  where penalty_id is not null;

comment on index public.payment_allocations_unique_penalty_per_payment is
  'One allocation per penalty per payment, the counterpart of payment_allocations_unique_per_payment for the penalty target.';

-- Reaching a penalty's allocations from the penalty side: the balance views
-- aggregate by penalty, and without this they would scan the whole table.
create index payment_allocations_penalty_id_idx
  on public.payment_allocations (penalty_id)
  where penalty_id is not null;

comment on table public.payment_allocations is
  'Where each payment went: one row per obligation it satisfied, either a scheduled collection or a penalty, never both. Append-only; a reversal leaves these rows standing and stops counting them.';
