-- ===========================================================================
-- Polytos Phase 2.13 — membership cards
--
-- ## A card is an issue, not a column
--
-- Phase 1 deliberately left `card_number` off `memberships`. A column would
-- record the current card and lose every one before it, and "this member has
-- reported two cards lost" is exactly the thing a register needs to be able
-- to answer. So a card is a row, and reissuing is a new row that supersedes
-- the old one.
--
-- Reissuing therefore **cannot** create a membership or touch a balance.
-- There is nothing in this table that could: it references the membership and
-- carries no money.
--
-- ## The verification code is not a key to anything
--
-- A card carries a short code that a QR may encode. It is deliberately
-- **not** the membership number, not a client id and not a token: it is a
-- random opaque string that identifies the card to somebody who already has
-- the right to look one up. Scanning it opens a staff screen that still asks
-- for a session and still applies every policy; a scan by a stranger reveals
-- nothing and opens nothing.
--
-- That is the whole design requirement from the brief — "QR codes must not
-- expose private customer information or provide unauthenticated access" —
-- and it is met by the code meaning nothing on its own rather than by hoping
-- nobody scans it.
-- ===========================================================================

create table public.membership_cards (
  id uuid primary key default gen_random_uuid(),

  card_number text not null unique,

  membership_id uuid not null references public.memberships(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,

  -- The member's name as it was printed. A card in a wallet does not change
  -- when a name is corrected in the register, and a reader checking one
  -- against the record needs to know what it says.
  printed_name text not null,

  -- Opaque. See the header: it identifies a card to somebody already
  -- entitled to look one up, and is useless to anybody else.
  verification_code text not null unique,

  status text not null default 'active',
  issue_reason text not null,

  issued_on date not null,
  issued_by uuid references public.profiles(id) on delete set null,
  issued_by_label text not null default 'system',

  -- Set when a later card replaces this one.
  --
  -- Deferred, deliberately. `membership_cards_one_active_per_membership` is a
  -- partial unique index, which cannot be deferred, so the old card has to be
  -- stood down *before* the new one is written — and at that moment the card
  -- it points at does not exist yet. Deferring this one check to commit is
  -- what lets both facts be true at the end of the transaction without either
  -- being true in a wrong order in the middle of it.
  superseded_by uuid references public.membership_cards(id) on delete restrict
    deferrable initially deferred,
  superseded_at timestamptz,

  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint membership_card_number_shape
    check (card_number ~ '^MC[0-9]{6,}$'),
  constraint membership_card_status_valid
    check (status in ('active', 'superseded', 'cancelled')),
  constraint membership_card_reason_valid
    check (issue_reason in ('first_issue', 'lost', 'damaged', 'name_change', 'expired')),
  constraint membership_card_printed_name_not_blank
    check (btrim(printed_name) <> ''),
  constraint membership_card_verification_code_shape
    check (verification_code ~ '^[A-Z0-9]{12}$'),
  constraint membership_card_superseded_complete
    check ((status = 'superseded') = (superseded_by is not null)),
  constraint membership_card_superseded_has_time
    check ((superseded_by is null) = (superseded_at is null)),
  constraint membership_card_not_own_successor
    check (superseded_by is distinct from id),
  constraint membership_card_issued_plausible
    check (issued_on >= '2020-01-01'::date)
);

comment on table public.membership_cards is
  'Polytos Phase 2. Every card ever issued to a membership, including the ones replaced. Reissuing writes a new row and supersedes the old; it creates no membership and moves no money, because there is nothing here that could.';
comment on column public.membership_cards.verification_code is
  'Opaque and random. Identifies a card to a caller who already holds membership:view; it is not a token, not a key and not derived from any identifier. A QR encoding it reveals nothing to a stranger.';

-- One active card per membership. A second would mean two cards in
-- circulation that both claim to be current.
create unique index membership_cards_one_active_per_membership
  on public.membership_cards (membership_id)
  where status = 'active';

create index membership_cards_membership_idx
  on public.membership_cards (membership_id, issued_on desc);
create index membership_cards_branch_idx on public.membership_cards (branch_id);

create trigger membership_cards_set_updated_at
  before update on public.membership_cards
  for each row execute function public.set_updated_at();

create or replace function public.membership_cards_assign_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.card_number is not null then
    raise exception
      'A card number is assigned by the database, not by the caller.'
      using errcode = 'P0001';
  end if;

  new.card_number := public.next_reference('membership_card');
  return new;
end;
$$;

create trigger membership_cards_assign_number
  before insert on public.membership_cards
  for each row execute function public.membership_cards_assign_number();

revoke all on function public.membership_cards_assign_number()
  from public, anon, authenticated;

create or replace function public.membership_cards_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.card_number is distinct from old.card_number
     or new.membership_id is distinct from old.membership_id
     or new.client_id is distinct from old.client_id
     or new.printed_name is distinct from old.printed_name
     or new.verification_code is distinct from old.verification_code
     or new.issued_on is distinct from old.issued_on
     or new.issue_reason is distinct from old.issue_reason
     or new.created_at is distinct from old.created_at then
    raise exception
      'A membership card records what was printed. Reissue it rather than editing it.'
      using errcode = 'P0001';
  end if;

  if old.status <> 'active' and new.status is distinct from old.status then
    raise exception
      'Card % is %, which is final.', old.card_number, old.status
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger membership_cards_guard
  before update on public.membership_cards
  for each row execute function public.membership_cards_guard();

create trigger membership_cards_no_delete
  before delete on public.membership_cards
  for each statement execute function public.reject_mutation();

revoke all on function public.membership_cards_guard()
  from public, anon, authenticated;

-- ===========================================================================
-- issue_membership_card()
--
-- First issue and reissue are the same act with a different reason, so they
-- are one function. The old card is superseded in the same transaction, which
-- is what stops two cards both claiming to be current.
-- ===========================================================================

create or replace function public.issue_membership_card(
  p_membership_id uuid,
  p_reason text default 'first_issue'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_membership public.memberships;
  v_client     public.clients;
  v_actor      uuid;
  v_existing   uuid;
  v_card_id    uuid;
  v_code       text;
begin
  v_actor := public.current_profile_id();

  if auth.uid() is not null
     and not public.user_has_permission('membership:update') then
    raise exception
      'Issuing a membership card requires the membership:update capability.'
      using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('membership_card:' || p_membership_id::text)
  );

  select * into v_membership
  from public.memberships where id = p_membership_id for update;

  if not found then
    raise exception 'No such membership.' using errcode = 'P0001';
  end if;

  -- A card says "this person is a member". A pending application is not yet
  -- one, and a withdrawn membership is no longer one.
  if v_membership.status not in ('active', 'suspended') then
    raise exception
      'Membership % is %. A card is issued to a member, and that is neither.',
      v_membership.membership_number, v_membership.status
      using errcode = 'P0001';
  end if;

  select * into v_client from public.clients where id = v_membership.client_id;

  select id into v_existing
  from public.membership_cards
  where membership_id = p_membership_id and status = 'active';

  if v_existing is not null and p_reason = 'first_issue' then
    raise exception
      'Membership % already has a card. Reissue it with a reason instead.',
      v_membership.membership_number using errcode = 'P0001';
  end if;

  if v_existing is null and p_reason <> 'first_issue' then
    raise exception
      'Membership % has no card to replace.', v_membership.membership_number
      using errcode = 'P0001';
  end if;

  -- Twelve characters from a 32-symbol alphabet: no I, O, 0 or 1, because a
  -- code is read aloud and typed by people. Collisions are refused by the
  -- unique constraint rather than hoped away, and the loop retries.
  loop
    v_code := (
      select pg_catalog.string_agg(
        pg_catalog.substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
                          1 + pg_catalog.floor(pg_catalog.random() * 32)::integer, 1),
        '')
      from pg_catalog.generate_series(1, 12)
    );
    exit when not exists (
      select 1 from public.membership_cards where verification_code = v_code
    );
  end loop;

  -- The new card's id is minted here so the old one can point at it before
  -- it exists. The old card is stood down first, because
  -- `membership_cards_one_active_per_membership` is a partial unique index
  -- and two active cards must not coexist even for the length of a
  -- statement; the forward reference is what `superseded_by` is deferred for.
  v_card_id := pg_catalog.gen_random_uuid();

  if v_existing is not null then
    update public.membership_cards
       set status = 'superseded',
           superseded_by = v_card_id,
           superseded_at = pg_catalog.now()
     where id = v_existing;
  end if;

  insert into public.membership_cards (
    id, membership_id, client_id, branch_id, printed_name, verification_code,
    issue_reason, issued_on, issued_by, issued_by_label
  )
  values (
    v_card_id, p_membership_id, v_membership.client_id, v_membership.branch_id,
    v_client.full_name, v_code, p_reason, public.business_date(),
    v_actor, public.audit_actor_label()
  );

  return v_card_id;
end;
$$;

comment on function public.issue_membership_card(uuid, text) is
  'Polytos Phase 2. Issues or reissues a membership card, superseding the previous one in the same transaction. Creates no membership and moves no money.';

revoke all on function public.issue_membership_card(uuid, text) from public, anon;
grant execute on function public.issue_membership_card(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------

-- Stripped before anything is granted: `CREATE TABLE` inherits default
-- privileges that hand `authenticated` everything, and granting SELECT does
-- not take DELETE away. 20261020001100 revokes this table too — both are
-- stated, because a reader of either migration should see the rule.
revoke all on table public.membership_cards from anon, authenticated;
grant select on table public.membership_cards to authenticated;

alter table public.membership_cards enable row level security;

create policy membership_cards_select
  on public.membership_cards
  for select
  to authenticated
  using (
    (
      (select public.user_has_permission('membership:view'))
      or exists (
        select 1 from public.clients c
        where c.id = membership_cards.client_id
          and c.profile_id is not null
          and c.profile_id = (select public.current_profile_id())
      )
    )
    and (
      branch_id is null
      or (select public.current_user_branch_id()) is null
      or branch_id = (select public.current_user_branch_id())
    )
  );

comment on policy membership_cards_select on public.membership_cards is
  'Staff holding membership:view read cards within their branch; a member reads their own. anon reads nothing, which is what makes a scanned code useless to a stranger.';

-- ---------------------------------------------------------------------------
-- The audit trail
-- ---------------------------------------------------------------------------

create or replace function public.audit_membership_card_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.record_audit_event(
    case when tg_op = 'INSERT' then 'membership_card.issued'
         else 'membership_card.' || new.status end,
    'membership_card',
    new.id::text,
    case when tg_op = 'UPDATE'
         then pg_catalog.jsonb_build_object('status', old.status) end,
    pg_catalog.jsonb_build_object(
      'card_number', new.card_number,
      'membership_id', new.membership_id,
      'issue_reason', new.issue_reason,
      'status', new.status,
      'superseded_by', new.superseded_by
      -- The verification code is deliberately absent: an audit row carrying
      -- it would put the code in a table read under different rules from the
      -- card it belongs to.
    ),
    pg_catalog.jsonb_build_object('card_number', new.card_number)
  );

  return new;
end;
$$;

create trigger audit_membership_card_change
  after insert or update on public.membership_cards
  for each row execute function public.audit_membership_card_change();

revoke all on function public.audit_membership_card_change()
  from public, anon, authenticated;
