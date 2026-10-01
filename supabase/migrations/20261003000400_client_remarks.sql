-- ===========================================================================
-- Phase 3 — client remarks.
--
-- The confirmed requirement is that a Manager can record concerns about a
-- client: a payment running late, a business that has closed, a promise made
-- at the counter. Those remarks are the institutional memory that decides
-- whether the next loan is approved, so their value depends entirely on their
-- being trustworthy — a remark that can be quietly reworded afterwards is
-- worth nothing as evidence of what was known when.
--
-- So this table is append-only, enforced the same way `audit_log` is: a
-- statement-level BEFORE trigger that refuses UPDATE and DELETE outright,
-- rather than merely withholding the grants. Withholding grants stops a
-- session; it does not stop the privileged client, and the privileged client
-- is what a leaked secret key becomes.
--
-- A remark can be *retracted*, which appends a new remark marking the
-- retraction rather than removing anything. That keeps the record honest while
-- still letting a Manager correct themselves.
-- ===========================================================================

create table public.client_remarks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,

  body text not null,

  -- A coarse category, so the client page can group "payment concern" apart
  -- from "contact detail confirmed". Deliberately short and closed: a free
  -- text category becomes thirty spellings of the same thing.
  category text not null default 'general',

  -- Who, derived from the session by a trigger rather than supplied.
  --
  -- `on delete restrict`, not `set null`, for two reasons that agree. The
  -- mechanical one: nulling a column is an UPDATE, and this table refuses
  -- every UPDATE, so `set null` would make the referenced profile
  -- undeletable with a confusing error instead of a clear one. The real one:
  -- a remark whose author has been erased is weaker evidence than one that
  -- still names them, and nothing in this application hard-deletes a
  -- profile — accounts are archived. `created_by_label` additionally keeps
  -- the author's name readable after their account is archived.
  created_by uuid references public.profiles (id) on delete restrict,
  created_by_label text not null default 'system',
  created_at timestamptz not null default pg_catalog.now(),

  -- A retraction points at the remark it retracts. The retracted remark is
  -- not modified — nothing in this table ever is.
  retracts_remark_id uuid references public.client_remarks (id) on delete restrict,

  constraint client_remarks_body_not_blank
    check (btrim(body) <> ''),
  -- Lower bound: a one-character remark is a mis-click, not a note. Upper
  -- bound: long enough for a paragraph, short enough that the column cannot
  -- be used to store a document.
  constraint client_remarks_body_length
    check (char_length(btrim(body)) between 3 and 2000),
  constraint client_remarks_category_valid
    check (category in ('general', 'payment_concern', 'contact', 'business', 'retraction')),
  -- A retraction must say so in its category, and only a retraction may point
  -- at another remark.
  constraint client_remarks_retraction_consistent
    check (
      (category = 'retraction' and retracts_remark_id is not null)
      or (category <> 'retraction' and retracts_remark_id is null)
    )
);

comment on table public.client_remarks is
  'Append-only internal staff commentary on a client. Never updated or deleted; a mistake is corrected by appending a retraction.';
comment on column public.client_remarks.created_by_label is
  'The author''s name as it was when the remark was written, so the remark stays readable after the account is archived.';
comment on column public.client_remarks.retracts_remark_id is
  'Set only on a remark of category `retraction`, naming the remark it withdraws. The withdrawn remark is left exactly as written.';

create index client_remarks_client_idx
  on public.client_remarks (client_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Append-only, enforced
-- ---------------------------------------------------------------------------

-- `reject_mutation()` is the Phase 1 statement-level guard used by audit_log.
-- Statement-level means it fires even for an UPDATE matching no rows, so the
-- refusal does not depend on the attacker's WHERE clause being correct.
create trigger client_remarks_no_update
  before update on public.client_remarks
  execute function public.reject_mutation();

create trigger client_remarks_no_delete
  before delete on public.client_remarks
  execute function public.reject_mutation();

-- ---------------------------------------------------------------------------
-- Authorship
-- ---------------------------------------------------------------------------

create or replace function public.client_remarks_stamp_author()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_label text;
begin
  v_actor := public.current_profile_id();

  if v_actor is not null then
    select p.full_name into v_label from public.profiles p where p.id = v_actor;
  end if;

  -- Derived, never accepted from the payload: a remark attributed to somebody
  -- else is worse than no remark.
  new.created_by := v_actor;
  new.created_by_label :=
    coalesce(nullif(pg_catalog.btrim(v_label), ''), 'system');

  -- A retraction must point at a remark on the same client. Otherwise one
  -- client's record could be used to annotate another's.
  if new.retracts_remark_id is not null then
    if not exists (
      select 1 from public.client_remarks r
      where r.id = new.retracts_remark_id
        and r.client_id = new.client_id
    ) then
      raise exception 'A retraction must name a remark on the same client.'
        using errcode = 'P0001';
    end if;

    if exists (
      select 1 from public.client_remarks r
      where r.retracts_remark_id = new.retracts_remark_id
    ) then
      raise exception 'That remark has already been retracted.'
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.client_remarks_stamp_author() is
  'BEFORE INSERT on client_remarks: derives the author from the session and validates a retraction''s target.';

create trigger client_remarks_stamp_author
  before insert on public.client_remarks
  for each row execute function public.client_remarks_stamp_author();

revoke all on function public.client_remarks_stamp_author()
  from public, anon, authenticated;

alter table public.client_remarks enable row level security;
revoke all on table public.client_remarks from anon, authenticated;
