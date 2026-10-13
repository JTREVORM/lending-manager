-- ===========================================================================
-- Phase 14.3 — releasing a guarantor, and the exposure register
--
-- Phase 13 made a guarantee a first-class thing: who stood for the loan, on
-- what terms, signed when, frozen at approval. What it did not give was the
-- other end of the story. A guarantee is an open-ended liability on a person
-- who is not the borrower, and the single most common question asked about one
-- is "am I still on the hook?" — a question a register with no release concept
-- cannot answer except by inference.
--
-- Most guarantees end by themselves: the loan clears, or it is cancelled, and
-- the undertaking has nothing left to secure. Those need no columns, because
-- the loan already records them and a derived status is always right. What
-- needs recording is the *discretionary* release — a Manager letting a
-- guarantor out while the loan is still live, usually because security was
-- substituted or another guarantor took their place. That is a decision with
-- an actor, a date and a reason, and it is the one a guarantor will come back
-- and ask about.
--
-- ## Why a function and not a column write
--
-- The RLS on `loan_guarantors` was written for application assembly:
-- `loans:update_draft` plus `guarantors:link`. Releasing a guarantee from a
-- *live* loan is the opposite situation — the work is senior, not clerical, and
-- it is nobody's business to be editing draft applications in order to do it.
-- So the release goes through a definer function gated on its own capability,
-- and the table's policies stay exactly as Phase 13 wrote them.
-- ===========================================================================

alter table public.loan_guarantors
  add column released_at timestamptz,
  add column released_by uuid references public.profiles(id) on delete set null,
  add column release_reason text;

alter table public.loan_guarantors
  add constraint loan_guarantors_release_consistent check (
    (released_at is null and released_by is null and release_reason is null)
    or (released_at is not null
        and char_length(btrim(coalesce(release_reason, ''))) between 3 and 500)
  );

comment on column public.loan_guarantors.released_at is
  'Set only by `release_loan_guarantor`. A discretionary release while the loan is still live; a guarantee that simply ended with the loan has no row-level release.';
comment on column public.loan_guarantors.release_reason is
  'Why the guarantor was let out. Required with a release, because a release with no reason is the one a guarantor will dispute.';

create index loan_guarantors_released_idx
  on public.loan_guarantors (released_at)
  where released_at is not null;

-- ---------------------------------------------------------------------------
-- A release does not come undone
-- ---------------------------------------------------------------------------

-- Re-emitted rather than replaced: `create or replace trigger` leaves the
-- existing trigger in place and swaps its definition, so no DDL drops a guard
-- even momentarily.
create or replace function public.loan_guarantors_guard_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.snapshot_at is not null
     and (new.snapshot_at is distinct from old.snapshot_at
       or new.snapshot_full_name is distinct from old.snapshot_full_name
       or new.snapshot_phone is distinct from old.snapshot_phone
       or new.snapshot_alternative_phone is distinct from old.snapshot_alternative_phone
       or new.snapshot_sex is distinct from old.snapshot_sex
       or new.snapshot_date_of_birth is distinct from old.snapshot_date_of_birth
       or new.snapshot_occupation is distinct from old.snapshot_occupation
       or new.snapshot_location is distinct from old.snapshot_location
       or new.snapshot_district is distinct from old.snapshot_district
       or new.snapshot_had_identification is distinct from old.snapshot_had_identification
       or new.snapshot_had_photograph is distinct from old.snapshot_had_photograph) then
    raise exception
      'The guarantor details frozen at approval cannot be changed. They are what the business relied on.'
      using errcode = 'P0001';
  end if;

  -- The consent is evidence too, from the moment it is signed.
  if old.consented_at is not null
     and (new.consented_at is distinct from old.consented_at
       or new.consent_terms_id is distinct from old.consent_terms_id
       or new.consent_version is distinct from old.consent_version
       or new.signature_name is distinct from old.signature_name
       or new.witness_name is distinct from old.witness_name) then
    raise exception
      'A signed guarantor undertaking cannot be altered. Take a fresh consent instead.'
      using errcode = 'P0001';
  end if;

  -- Phase 14: a release is told to a guarantor, who then stops worrying about
  -- the loan. Taking it back silently would make the register a liar about the
  -- thing it exists to state.
  if old.released_at is not null
     and (new.released_at is distinct from old.released_at
       or new.released_by is distinct from old.released_by
       or new.release_reason is distinct from old.release_reason) then
    raise exception
      'This guarantee has already been released. That cannot be undone or reworded.'
      using errcode = 'P0001';
  end if;

  -- And a release is only ever stamped by `release_loan_guarantor`, which
  -- checks the capability for it. A direct column write is refused even from a
  -- session that can otherwise edit the row.
  if old.released_at is null and new.released_at is not null
     and pg_catalog.current_setting('lending.releasing_guarantee', true) is distinct from 'on' then
    raise exception
      'Releasing a guarantee goes through release_loan_guarantor().'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create or replace trigger loan_guarantors_guard_snapshot
  before update on public.loan_guarantors
  for each row execute function public.loan_guarantors_guard_snapshot();

-- ---------------------------------------------------------------------------
-- The release itself
-- ---------------------------------------------------------------------------

create or replace function public.release_loan_guarantor(
  p_loan_guarantor_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.loan_guarantors;
  v_loan public.loans;
  v_remaining integer;
  v_required integer;
begin
  if p_reason is null or pg_catalog.btrim(p_reason) = '' then
    raise exception 'Releasing a guarantor requires a reason.'
      using errcode = 'P0001';
  end if;

  if auth.uid() is not null and not public.user_has_permission('guarantors:release') then
    raise exception 'Releasing a guarantor requires the guarantors:release capability.'
      using errcode = 'P0001';
  end if;

  select * into v_row
    from public.loan_guarantors
   where id = p_loan_guarantor_id
     for update;

  if not found then
    raise exception 'No such guarantee.' using errcode = 'P0001';
  end if;

  if v_row.released_at is not null then
    raise exception 'This guarantee was already released.' using errcode = 'P0001';
  end if;

  select * into v_loan from public.loans where id = v_row.loan_id;

  -- A draft's guarantors are removed, not released: nothing has been promised
  -- to anybody yet, and a release row on an application that never became a
  -- loan is noise in the register.
  if v_loan.status in ('draft', 'pending_approval', 'approved') then
    raise exception
      'This loan has not been disbursed. Remove the guarantor from the application instead.'
      using errcode = 'P0001';
  end if;

  -- Where the loan is over, the guarantee ended with it and the register
  -- already says so. Stamping a discretionary release on top would invent a
  -- decision nobody made.
  if v_loan.status in ('cleared', 'cancelled') then
    raise exception
      'This guarantee ended when the loan was %. There is nothing to release.',
      v_loan.status using errcode = 'P0001';
  end if;

  -- A live loan must keep the cover its product requires. Releasing the last
  -- guarantor of a loan that needs two is not a release, it is leaving the
  -- business unsecured, and it should be refused rather than warned about.
  select p.min_guarantors into v_required
    from public.loan_products p
   where p.id = v_loan.loan_product_id;

  select pg_catalog.count(*)::integer into v_remaining
    from public.loan_guarantors g
   where g.loan_id = v_row.loan_id
     and g.id <> v_row.id
     and g.released_at is null;

  if v_remaining < coalesce(v_required, 0) then
    raise exception
      'This loan requires % guarantor(s) and would be left with %. Attach a replacement before releasing this one.',
      v_required, v_remaining using errcode = 'P0001';
  end if;

  perform pg_catalog.set_config('lending.releasing_guarantee', 'on', true);

  update public.loan_guarantors
     set released_at = pg_catalog.now(),
         released_by = public.current_profile_id(),
         release_reason = pg_catalog.btrim(p_reason)
   where id = p_loan_guarantor_id;

  perform pg_catalog.set_config('lending.releasing_guarantee', 'off', true);

  insert into public.audit_log (
    actor_profile_id, actor_auth_user_id, actor_label,
    action, entity_type, entity_id, new_values
  )
  values (
    public.current_profile_id(), auth.uid(), public.audit_actor_label(),
    'loan.guarantor_released', 'loan', v_row.loan_id::text,
    pg_catalog.jsonb_build_object(
      'loan_guarantor_id', p_loan_guarantor_id,
      'reason', pg_catalog.btrim(p_reason),
      'guarantors_remaining', v_remaining
    )
  );

  return p_loan_guarantor_id;
end;
$$;

comment on function public.release_loan_guarantor(uuid, text) is
  'Phase 14. Lets a guarantor out of a live loan, with a reason, provided the loan keeps the number of guarantors its product requires. Refuses a draft (remove instead) and a finished loan (the guarantee ended with it).';

revoke all on function public.release_loan_guarantor(uuid, text) from public, anon;
grant execute on function public.release_loan_guarantor(uuid, text) to authenticated;

insert into public.permissions (key, description) values
  ('guarantors:release', 'Release a guarantor from a live loan.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key) values
  ('manager', 'guarantors:release'),
  ('owner_admin', 'guarantors:release')
on conflict (role_key, permission_key) do nothing;

-- ---------------------------------------------------------------------------
-- The exposure register
--
-- One row per guarantee, answering the questions a guarantor register is for:
-- who stood for whom, on which product, for how much, what is still owed, and
-- whether the undertaking still binds.
-- ---------------------------------------------------------------------------

create view public.guarantor_exposure with (security_invoker = true) as
select
  g.id as loan_guarantor_id,
  g.loan_id,
  l.loan_number,
  l.status as loan_status,
  l.branch_id,
  p.id as loan_product_id,
  p.product_code,
  p.name as product_name,

  -- The guarantor, preferring what was frozen at approval over what the
  -- underlying record says today: the register should name the person the
  -- business relied on.
  case when g.guarantor_client_id is not null then 'client' else 'external' end
    as subject_kind,
  g.guarantor_id,
  g.guarantor_client_id,
  coalesce(
    g.snapshot_full_name,
    gc.full_name,
    ex.full_name
  ) as guarantor_name,
  coalesce(g.snapshot_phone, gc.phone, ex.phone) as guarantor_phone,
  gc.client_number as guarantor_client_number,
  g.relationship_to_client,

  -- The borrower.
  l.client_id,
  b.client_number,
  b.full_name as client_name,
  b.phone as client_phone,

  -- What was guaranteed, and what is still exposed.
  --
  -- A guarantee in this business is joint over the whole loan: nobody signs
  -- for a slice of it, so these are the loan's figures and are deliberately
  -- not divided by the number of guarantors. Two guarantors on one loan both
  -- show the full exposure, which is the truth of what each of them signed.
  l.principal_amount as guaranteed_amount,
  l.total_expected_repayment as guaranteed_total,
  d.total_outstanding as outstanding_balance,
  d.arrears_amount,
  d.days_past_due,
  d.delinquency_state,

  g.consented_at as guarantee_date,
  g.consent_version,
  (g.consented_at is not null) as consent_signed,
  g.snapshot_at as evidence_frozen_at,

  g.released_at,
  g.release_reason,
  (g.released_at is not null) as is_released,

  case
    when g.released_at is not null then 'released'
    when l.status = 'cleared' then 'discharged'
    when l.status = 'cancelled' then 'void'
    when l.status in ('draft', 'pending_approval', 'approved') then 'proposed'
    when g.consented_at is null then 'unsigned'
    else 'binding'
  end as guarantee_status,

  g.created_at
from public.loan_guarantors g
join public.loans l on l.id = g.loan_id
join public.loan_products p on p.id = l.loan_product_id
join public.clients b on b.id = l.client_id
left join public.clients gc on gc.id = g.guarantor_client_id
left join public.guarantors ex on ex.id = g.guarantor_id
left join public.loan_delinquency d on d.loan_id = l.id;

comment on view public.guarantor_exposure is
  'Phase 14. The guarantor register: every guarantee with its guarantor, borrower, product, guaranteed amount, outstanding exposure, guarantee date and status. A guarantee is joint over the whole loan, so the exposure shown against each guarantor is the loan''s, undivided.';

revoke all on public.guarantor_exposure from anon, authenticated;
grant select on public.guarantor_exposure to authenticated;
