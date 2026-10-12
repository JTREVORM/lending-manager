-- ===========================================================================
-- Phase 12.4 — who may change a product, and what happens when they do
--
-- 12.2 created `loan_products` with a read policy and nothing else, which
-- makes it configuration only a migration can change. The brief asks for the
-- opposite: the Owner creates a product, edits its terms, activates and
-- deactivates it, from a screen.
--
-- Three things that needs, and this migration is exactly those three:
--
--   1. **Write access, scoped.** `products:manage` — which only the Owner
--      holds — may insert and update. Nobody may DELETE: a product with
--      loans written against it is referenced by every one of their
--      snapshots, and retiring is what `status = 'inactive'` is for. The
--      privilege is simply not granted, so this is not a policy somebody can
--      widen by accident.
--
--   2. **An audit record.** Repricing a product changes what the business
--      lends at. `business_settings` has been audited since Phase 2 for that
--      reason, and a product is now where the rate actually lives, so it is
--      audited the same way and by the same append-only log.
--
--   3. **Two things a person must not supply.** Who created and who last
--      changed a product are stamped from the session, not accepted from the
--      caller, exactly as every other actor column in this schema is. And
--      `product_code` cannot be changed at all: it is the identifier a
--      snapshot, an export and a report all carry, and renaming it after the
--      fact would silently relabel history.
--
-- `finance_settings` gets its UPDATE policy here too, for the same reason:
-- 12.1 of Phase 11 created it readable and unwritable, and the approval
-- thresholds it holds are a business decision, not a deployment constant.
-- `finance:settings` gates it rather than `settings:update`, because the
-- capability already exists for precisely this and the two sets of settings
-- are deliberately different jobs.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Finance settings
-- ---------------------------------------------------------------------------

grant update on table public.finance_settings to authenticated;

create policy finance_settings_update_with_permission
  on public.finance_settings for update to authenticated
  using (public.user_has_permission('finance:settings'))
  with check (public.user_has_permission('finance:settings'));

-- ---------------------------------------------------------------------------
-- Products: the actor columns, stamped
-- ---------------------------------------------------------------------------

create or replace function public.loan_products_stamp_actor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  v_actor := public.current_profile_id();

  if tg_op = 'INSERT' then
    -- `coalesce`, not an overwrite: a migration or a seed runs with no
    -- session and may legitimately name the actor itself, or leave it null.
    new.created_by := coalesce(v_actor, new.created_by);
    new.updated_by := coalesce(v_actor, new.updated_by);
    return new;
  end if;

  -- An update may not reassign authorship, and may not rename the product's
  -- identifier. Both are silently restored rather than refused: the UI never
  -- sends either, so a request that carries one is a request that was
  -- assembled by hand.
  new.created_by   := old.created_by;
  new.product_code := old.product_code;
  new.updated_by   := coalesce(v_actor, old.updated_by);

  return new;
end;
$$;

comment on function public.loan_products_stamp_actor() is
  'Phase 12. Stamps created_by/updated_by from the session and refuses a renamed product_code or reassigned authorship. The identifier appears on every snapshot and export, so renaming it would relabel history.';

revoke all on function public.loan_products_stamp_actor() from public, anon, authenticated;

create trigger loan_products_stamp_actor
  before insert or update on public.loan_products
  for each row execute function public.loan_products_stamp_actor();

-- ---------------------------------------------------------------------------
-- Products: the audit record
--
-- `audit_settings_change` is not reused: it is a trigger on a singleton and
-- writes `old.id::text` with the table name as the entity type, which for a
-- table of many rows would record "something in loan_products changed" and
-- leave a reader to guess which product. This writes the product's own id and
-- a `product.created` / `product.updated` action.
-- ---------------------------------------------------------------------------

create or replace function public.audit_loan_product_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile uuid;
  v_actor_label   text;
  v_row           public.loan_products;
begin
  v_actor_profile := public.current_profile_id();

  if v_actor_profile is not null then
    select p.full_name into v_actor_label
    from public.profiles p
    where p.id = v_actor_profile;
  end if;

  v_actor_label := coalesce(nullif(pg_catalog.btrim(v_actor_label), ''), 'system');

  v_row := case when tg_op = 'DELETE' then old else new end;

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, old_values, new_values
  )
  values (
    v_actor_profile, auth.uid(), v_actor_label,
    case tg_op when 'INSERT' then 'product.created' else 'product.updated' end,
    'loan_product', v_row.id::text,
    case when tg_op = 'INSERT' then null else pg_catalog.to_jsonb(old) end,
    pg_catalog.to_jsonb(new)
  );

  return null;
end;
$$;

comment on function public.audit_loan_product_change() is
  'Phase 12. AFTER INSERT OR UPDATE on loan_products. A product holds the rate the business lends at, so changing one is recorded the way changing business_settings has been since Phase 2.';

revoke all on function public.audit_loan_product_change() from public, anon, authenticated;

create trigger audit_loan_product_change
  after insert or update on public.loan_products
  for each row execute function public.audit_loan_product_change();

-- ---------------------------------------------------------------------------
-- Products: write access
--
-- No DELETE grant and no delete policy, deliberately. See the head of this
-- file: a product is retired, never removed.
-- ---------------------------------------------------------------------------

grant insert, update on table public.loan_products to authenticated;
grant insert, delete on table public.loan_product_branches to authenticated;

create policy loan_products_insert_with_permission
  on public.loan_products for insert to authenticated
  with check (public.user_has_permission('products:manage'));

create policy loan_products_update_with_permission
  on public.loan_products for update to authenticated
  using (public.user_has_permission('products:manage'))
  with check (public.user_has_permission('products:manage'));

-- Where a product is sold is part of the product, so the same capability
-- governs it. DELETE is granted here and not on the product itself because
-- removing a branch from a product's availability removes no history: the
-- loans written at that branch keep their own branch_id and their own
-- snapshot.
create policy loan_product_branches_insert_with_permission
  on public.loan_product_branches for insert to authenticated
  with check (public.user_has_permission('products:manage'));

create policy loan_product_branches_delete_with_permission
  on public.loan_product_branches for delete to authenticated
  using (public.user_has_permission('products:manage'));
