-- ===========================================================================
-- Phase 13.5 — what the application layer needs, and two defects beneath it
--
-- 13.1 to 13.4 gave the application its own shape: a typed closure, the
-- product's own questions, the loan's own guarantors, and an approval that
-- reads all three. Building the screens over them turned up two things the
-- schema got wrong and three things it does not yet hold.
--
-- ## Defect one: a Manager could approve an application but not refuse one
--
-- `reject_loan` checks `loans:approve`, on the stated reasoning that a
-- business which could grant the power to say yes without the power to say no
-- is not a business anybody wants. It then performs an UPDATE to
-- `status = 'cancelled'` — and `loans_guard_transition`, which predates the
-- idea of a refusal, demands `loans:cancel` for *any* move to that state.
--
-- The Manager role holds `loans:approve` and not `loans:cancel`. So the one
-- role the function was written for was the one role it refused. Found by
-- asking a Manager to reject an application.
--
-- The fix reads the kind rather than the state: a refusal needs
-- `loans:approve`, a withdrawal needs `loans:cancel`. The two decisions end in
-- the same row and were never the same decision.
--
-- ## Defect two: the product was frozen everywhere except in the schema
--
-- `capture_loan_product_snapshot` records a loan's product and rate at
-- approval, and `loans_guard_transition` freezes the principal, the term, the
-- cadence, the borrower and the agreed rate once a loan leaves draft. It did
-- not freeze `loan_product_id` or `proposed_interest_rate_bps`, so an approved
-- loan could be moved to a different product and would then disagree with its
-- own snapshot — the snapshot saying Salary Loan, the loan saying Quick Loan,
-- and every report by product picking whichever one it happened to read.
--
-- Both fixes are made by re-emitting the function from `pg_get_functiondef`
-- with the two edits applied, rather than by retyping two hundred lines of
-- lifecycle rules.
--
-- ## What is new
--
--   * `loan_documents` — the evidence attached to an application: a payslip,
--     an employment letter, a trading licence, a bank statement, a
--     guarantor's identification, photograph or signature. One table, because
--     a document is a document; the kind says what it is.
--
--   * `loan_workflow_register` — one row per loan carrying its product, its
--     collection state and its guarantor count, so the thirteen views the
--     loan module presents are thirteen filters over one query rather than
--     thirteen queries.
--
--   * `guarantor_candidates` — the existing clients who may back a given
--     application, each with the reasons they may not. The screen shows the
--     reasons; the trigger and the approval validator remain the enforcement.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The two fixes to the lifecycle guard
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.loans_guard_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_allowed     boolean;
  v_approving   boolean;
  v_outstanding bigint;
begin
  -- --- Rules binding every caller, including service_role ------------------
  -- Stated before the trusted-path exemption, following the Phase 2 lesson: a
  -- rule after the exemption is one the privileged client can skip, and a
  -- leaked secret key becomes the privileged client.

  if new.loan_number is distinct from old.loan_number then
    raise exception 'A loan number cannot be changed once issued.'
      using errcode = 'P0001';
  end if;

  if new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'Loan provenance cannot be rewritten.'
      using errcode = 'P0001';
  end if;

  -- The transition itself.
  if new.status is distinct from old.status then
    v_allowed := (old.status, new.status) in (
      ('draft', 'pending_approval'),
      ('draft', 'cancelled'),
      ('pending_approval', 'draft'),
      ('pending_approval', 'approved'),
      ('pending_approval', 'cancelled'),
      ('approved', 'active'),
      ('approved', 'cancelled'),
      ('active', 'cleared'),
      -- Phase 6: a reversal that leaves money outstanding reopens the loan.
      ('cleared', 'active')
    );

    if not v_allowed then
      raise exception
        'A loan cannot move from % to %.', old.status, new.status
        using errcode = 'P0001';
    end if;
  end if;

  -- --- Phase 6: the status may never contradict the ledger -----------------
  --
  -- Checked from the data rather than trusted to a caller or a session
  -- marker, so these two transitions are correct whatever path reached them —
  -- the posting function, a direct UPDATE, or `service_role`.
  -- Phase 7 changes one thing here, and it is the thing that matters: the
  -- figure is now `loan_total_outstanding`, which includes an unpaid penalty.
  -- With the Phase 6 function a borrower could settle their contractual
  -- obligations, leave a 50,000 penalty standing, and the loan would clear.
  if new.status = 'cleared' and old.status = 'active' then
    v_outstanding := public.loan_total_outstanding(new.id);

    if v_outstanding <> 0 then
      raise exception
        'This loan cannot be cleared: % shillings are still outstanding, penalty included.',
        v_outstanding
        using errcode = 'P0001';
    end if;
  end if;

  if new.status = 'active' and old.status = 'cleared' then
    v_outstanding := public.loan_total_outstanding(new.id);

    if v_outstanding <= 0 then
      raise exception
        'This loan cannot be reopened: it owes nothing.'
        using errcode = 'P0001';
    end if;
  end if;

  -- --- Attribution is the database''s to write ----------------------------
  -- Derived from the session at the moment of the transition, and a supplied
  -- value is refused. Without this, an approval could name somebody who never
  -- saw the loan — precisely the record a dispute turns on.

  if new.status = 'pending_approval' and old.status = 'draft' then
    if new.submitted_at is distinct from old.submitted_at
       or new.submitted_by is distinct from old.submitted_by then
      raise exception 'Submission attribution is maintained by the database.'
        using errcode = 'P0001';
    end if;

    new.submitted_at := pg_catalog.now();
    new.submitted_by := public.current_profile_id();
  elsif new.status = 'draft' and old.status = 'pending_approval' then
    new.submitted_at := null;
    new.submitted_by := null;
  elsif new.submitted_at is distinct from old.submitted_at
     or new.submitted_by is distinct from old.submitted_by then
    raise exception 'Submission attribution is maintained by the database.'
      using errcode = 'P0001';
  end if;

  if new.status = 'approved' and old.status = 'pending_approval' then
    if new.approved_at is distinct from old.approved_at
       or new.approved_by is distinct from old.approved_by then
      raise exception 'Approval attribution is maintained by the database.'
        using errcode = 'P0001';
    end if;

    new.approved_at := pg_catalog.now();
    new.approved_by := public.current_profile_id();
  elsif new.approved_at is distinct from old.approved_at
     or new.approved_by is distinct from old.approved_by then
    raise exception 'Approval attribution is maintained by the database.'
      using errcode = 'P0001';
  end if;

  if new.status = 'active' and old.status = 'approved' then
    if new.disbursed_at is distinct from old.disbursed_at
       or new.disbursed_by is distinct from old.disbursed_by then
      raise exception 'Disbursement attribution is maintained by the database.'
        using errcode = 'P0001';
    end if;

    new.disbursed_at := pg_catalog.now();
    new.disbursed_by := public.current_profile_id();
  elsif new.disbursed_at is distinct from old.disbursed_at
     or new.disbursed_by is distinct from old.disbursed_by then
    raise exception 'Disbursement attribution is maintained by the database.'
      using errcode = 'P0001';
  end if;

  if new.status = 'cancelled' and old.status <> 'cancelled' then
    if new.cancelled_at is distinct from old.cancelled_at
       or new.cancelled_by is distinct from old.cancelled_by then
      raise exception 'Cancellation attribution is maintained by the database.'
        using errcode = 'P0001';
    end if;

    new.cancelled_at := pg_catalog.now();
    new.cancelled_by := public.current_profile_id();
  elsif new.cancelled_at is distinct from old.cancelled_at
     or new.cancelled_by is distinct from old.cancelled_by then
    raise exception 'Cancellation attribution is maintained by the database.'
      using errcode = 'P0001';
  end if;

  -- --- Phase 6: clearance attribution, on the same terms ------------------
  if new.status = 'cleared' and old.status = 'active' then
    if new.cleared_at is distinct from old.cleared_at
       or new.cleared_by is distinct from old.cleared_by then
      raise exception 'Clearance attribution is maintained by the database.'
        using errcode = 'P0001';
    end if;

    new.cleared_at := pg_catalog.now();
    new.cleared_by := public.current_profile_id();
  elsif new.status = 'active' and old.status = 'cleared' then
    -- Reopened. The stamp is cleared, so the column keeps meaning "currently
    -- cleared, at this time" rather than "was cleared once". Both events are
    -- in the audit trail, which is where history belongs.
    new.cleared_at := null;
    new.cleared_by := null;
  elsif new.cleared_at is distinct from old.cleared_at
     or new.cleared_by is distinct from old.cleared_by then
    raise exception 'Clearance attribution is maintained by the database.'
      using errcode = 'P0001';
  end if;

  -- --- What freezes, and when ---------------------------------------------
  v_approving := old.status = 'pending_approval' and new.status = 'approved';

  if old.status <> 'draft' then
    -- Rule one: the shape of the agreement.
    if new.principal_amount is distinct from old.principal_amount
       or new.loan_term_months is distinct from old.loan_term_months
       or new.repayment_frequency is distinct from old.repayment_frequency
       or new.client_id is distinct from old.client_id
       or new.currency_code is distinct from old.currency_code
       or new.proposed_disbursement_date is distinct from old.proposed_disbursement_date
       -- Phase 13. The product is the agreement's price list and the proposed
       -- rate is the price asked under it. Both were frozen in practice --
       -- `capture_loan_product_snapshot` records them at approval -- and
       -- neither was frozen in the schema, so an approved loan could be moved
       -- to a different product and disagree with its own snapshot.
       or new.loan_product_id is distinct from old.loan_product_id
       or new.proposed_interest_rate_bps is distinct from old.proposed_interest_rate_bps then
      raise exception
        'The agreed terms of a loan cannot be changed after it leaves draft. Cancel it and issue a new loan.'
        using errcode = 'P0001';
    end if;

    -- Rule two: the price, and the policy it was priced under.
    if not v_approving then
      if new.interest_rate_bps is distinct from old.interest_rate_bps
         or new.interest_method is distinct from old.interest_method then
        raise exception
          'A loan''s interest rate is set at approval and cannot be changed afterwards.'
          using errcode = 'P0001';
      end if;

      if new.total_interest is distinct from old.total_interest
         or new.total_expected_repayment is distinct from old.total_expected_repayment then
        raise exception
          'Loan totals are computed at approval and cannot be changed afterwards.'
          using errcode = 'P0001';
      end if;

      if new.min_loan_amount_applied is distinct from old.min_loan_amount_applied
         or new.max_loan_amount_applied is distinct from old.max_loan_amount_applied
         or new.grace_period_days_applied is distinct from old.grace_period_days_applied
         or new.penalty_rate_bps_applied is distinct from old.penalty_rate_bps_applied then
        raise exception
          'The policy snapshot on a loan cannot be changed after approval.'
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  -- --- The trusted server path -------------------------------------------
  -- NULL for service_role, the table owner, and migrations. The checks below
  -- are about a session's capabilities, and there is no session to check.
  if auth.uid() is null then
    return new;
  end if;

  -- --- Capability per transition ------------------------------------------
  if new.status is distinct from old.status then
    if new.status = 'pending_approval' and not public.user_has_permission('loans:submit') then
      raise exception 'Submitting a loan for approval requires the loans:submit capability.'
        using errcode = 'P0001';
    end if;

    if new.status = 'approved' and not public.user_has_permission('loans:approve') then
      raise exception 'Approving a loan requires the loans:approve capability.'
        using errcode = 'P0001';
    end if;

    if new.status = 'draft' and old.status = 'pending_approval'
       and not public.user_has_permission('loans:approve') then
      raise exception 'Returning a loan to draft requires the loans:approve capability.'
        using errcode = 'P0001';
    end if;

    if new.status = 'active' and old.status = 'approved'
       and not public.user_has_permission('loans:disburse') then
      raise exception 'Disbursing a loan requires the loans:disburse capability.'
        using errcode = 'P0001';
    end if;

    -- Phase 13. A refusal and a withdrawal end in the same state and are not
    -- the same decision, so they are not the same capability. Whoever may
    -- approve an application may refuse it -- a business that could grant the
    -- power to say yes without the power to say no is not a business anybody
    -- wants -- while taking back a loan the business already approved stays
    -- `loans:cancel`. `reject_loan` sets the kind, so the kind is what this
    -- reads.
    if new.status = 'cancelled' then
      if new.closure_kind = 'rejected' then
        if not public.user_has_permission('loans:approve') then
          raise exception
            'Refusing an application requires the loans:approve capability.'
            using errcode = 'P0001';
        end if;
      elsif not public.user_has_permission('loans:cancel') then
        raise exception 'Cancelling a loan requires the loans:cancel capability.'
          using errcode = 'P0001';
      end if;
    end if;

    -- --- Phase 6 ----------------------------------------------------------
    -- The capability is the one that *causes* the transition. Clearing a loan
    -- is a consequence of taking its final payment, so whoever may record a
    -- payment may clear it; reopening is a consequence of reversing, which
    -- only the Owner may do.
    if new.status = 'cleared' and old.status = 'active'
       and not public.user_has_permission('payments:create') then
      raise exception 'Clearing a loan requires the payments:create capability.'
        using errcode = 'P0001';
    end if;

    if new.status = 'active' and old.status = 'cleared'
       and not public.user_has_permission('payments:reverse') then
      raise exception 'Reopening a cleared loan requires the payments:reverse capability.'
        using errcode = 'P0001';
    end if;
  end if;

  -- Editing a draft.
  if old.status = 'draft' and new.status = 'draft'
     and not public.user_has_permission('loans:update_draft') then
    raise exception 'Changing a loan draft requires the loans:update_draft capability.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$function$;

comment on function public.loans_guard_transition() is
  'Phase 4, extended in Phases 6, 7 and 13. The loan state machine, the attribution rules, the terms freeze and the capability required by each transition. A refusal needs loans:approve; a withdrawal needs loans:cancel.';

-- ---------------------------------------------------------------------------
-- A guarantor's employer
--
-- The one fact the external-guarantor form asks for that `guarantors` could
-- not hold. `occupation` says what somebody does; it does not say who pays
-- them, which is what a recovery officer rings.
-- ---------------------------------------------------------------------------

alter table public.guarantors add column employer_name text;

comment on column public.guarantors.employer_name is
  'Phase 13. Who employs this guarantor, or the business they trade as. Optional: a subsistence farmer has an occupation and no employer.';

alter table public.guarantors add constraint guarantors_employer_length
  check (employer_name is null or char_length(btrim(employer_name)) between 2 and 120);

-- ---------------------------------------------------------------------------
-- The evidence attached to an application
--
-- ## One table rather than a column per document
--
-- 13.2 and 13.3 each gave their table a path column — `payslip_path`,
-- `employment_letter_path`, `trading_licence_path`, `bank_statement_path`,
-- `signature_path`. Those were the right shape for five named documents and
-- the wrong shape for the sixth, because the brief also asks for business
-- photographs, a guarantor's identification, and supporting documents in
-- general: an open-ended list.
--
-- So the paths move here and those columns are superseded. They are not
-- dropped — the tooling that reaches the live database cannot run a
-- destructive statement non-interactively, and a column nobody writes is
-- cheaper than a migration nobody can apply — but nothing writes them from
-- this phase onward, and the two views that read them are redefined below to
-- read this table instead. A reader who finds one populated is looking at a
-- row written before this migration; there are none.
--
-- ## A document belongs to a loan, not to a client
--
-- A payslip proves an income *at the time of an application*. Filing it
-- against the client would mean a loan written in March being assessed on a
-- payslip uploaded in September, which is exactly the confusion the frozen
-- application exists to prevent.
-- ---------------------------------------------------------------------------

create table public.loan_documents (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans(id) on delete restrict,

  -- Set for the three guarantor kinds and null for every other, so a
  -- guarantor's identification is attached to the guarantor rather than to
  -- the application in general.
  loan_guarantor_id uuid references public.loan_guarantors(id) on delete restrict,

  kind text not null,

  -- The object in the `loan-documents` bucket. Unique, because the name is
  -- generated from sixteen random bytes and a collision would mean one
  -- document overwriting another.
  storage_path text not null unique,

  -- What a person called it, bounded. Never the uploaded filename, which is
  -- attacker input and frequently carries the subject's name.
  label text,

  content_type text not null,
  byte_size integer not null,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  -- The label is the one field a correction touches: a document filed under
  -- the wrong description is renamed, never re-uploaded. Everything else on
  -- the row is refused by the guard below, so this timestamp advances exactly
  -- when a description changes.
  updated_at timestamptz not null default pg_catalog.now(),

  constraint loan_documents_kind_valid check (kind in (
    'payslip', 'employment_letter',
    'trading_licence', 'bank_statement', 'business_photo',
    'guarantor_identification', 'guarantor_photograph', 'guarantor_signature',
    'supporting'
  )),

  -- The shape the upload helper builds and the storage policies match, stated
  -- a third time here so a path that reached this column by any other route is
  -- refused. No leading slash and no traversal sequence, like every other path
  -- column in this schema.
  constraint loan_documents_path_shape
    check (storage_path ~ '^loans/[0-9a-f-]{36}/[a-z_]+/[0-9a-f]{32}\.[a-z0-9]+$'),

  constraint loan_documents_size_sane
    check (byte_size > 0 and byte_size <= 10485760),

  constraint loan_documents_label_length
    check (label is null or char_length(btrim(label)) between 2 and 120),

  constraint loan_documents_guarantor_kinds check (
    (loan_guarantor_id is not null)
    = (kind in ('guarantor_identification', 'guarantor_photograph', 'guarantor_signature'))
  )
);

create index loan_documents_loan_idx on public.loan_documents (loan_id);
create index loan_documents_guarantor_idx on public.loan_documents (loan_guarantor_id);

-- One signature per guarantor, one payslip per application. A second would be
-- a correction, and a correction replaces rather than accumulates.
create unique index loan_documents_one_guarantor_signature
  on public.loan_documents (loan_guarantor_id)
  where kind = 'guarantor_signature';

create unique index loan_documents_one_per_named_kind
  on public.loan_documents (loan_id, kind)
  where kind in ('payslip', 'employment_letter', 'trading_licence', 'bank_statement');

comment on table public.loan_documents is
  'Phase 13. The evidence attached to a loan application: payslips, employment letters, trading licences, bank statements, business photographs, and a guarantor''s identification, photograph or signature. Writable while the loan is a draft and frozen from submission, like everything else on the application.';

-- ---------------------------------------------------------------------------
-- A document is part of the application, so it is frozen with it
--
-- The same rule 13.2 applies to the salary and business answers, for the same
-- reason: a draft is meant to be corrected and everything after submission is
-- evidence. An approval made on a payslip that was swapped afterwards is an
-- approval nobody can account for.
--
-- Returning a loan to draft reopens it, which is right — that is what a
-- reviewer asking for a better scan means.
-- ---------------------------------------------------------------------------

create trigger loan_documents_set_updated_at
  before update on public.loan_documents
  for each row execute function public.set_updated_at();

create or replace function public.loan_documents_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loan_id uuid;
  v_status  text;
begin
  v_loan_id := case when tg_op = 'DELETE' then old.loan_id else new.loan_id end;

  select l.status into v_status from public.loans l where l.id = v_loan_id;

  if v_status is null then
    raise exception 'No such loan.' using errcode = 'P0001';
  end if;

  if v_status <> 'draft' then
    raise exception
      'The documents on a % application cannot be changed. They are what the decision was made on.',
      v_status using errcode = 'P0001';
  end if;

  if tg_op = 'UPDATE' then
    if new.loan_id is distinct from old.loan_id
       or new.kind is distinct from old.kind
       or new.storage_path is distinct from old.storage_path
       or new.loan_guarantor_id is distinct from old.loan_guarantor_id then
      raise exception
        'A document cannot be repointed. Remove it and attach the replacement.'
        using errcode = 'P0001';
    end if;

    new.created_by := old.created_by;
    new.created_at := old.created_at;
  else
    if tg_op = 'INSERT' then
      new.created_by := coalesce(public.current_profile_id(), new.created_by);
    end if;
  end if;

  -- A guarantor's document belongs to a guarantor on *this* loan.
  if tg_op <> 'DELETE' and new.loan_guarantor_id is not null then
    if not exists (
      select 1 from public.loan_guarantors lg
      where lg.id = new.loan_guarantor_id and lg.loan_id = new.loan_id
    ) then
      raise exception 'That guarantor is not on this application.'
        using errcode = 'P0001';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function public.loan_documents_guard() is
  'Phase 13. Confines every write to loan_documents to a loan that is still a draft, stamps the uploader, and keeps a stored document pointing where it was filed.';

revoke all on function public.loan_documents_guard() from public, anon, authenticated;

create trigger loan_documents_guard
  before insert or update or delete on public.loan_documents
  for each row execute function public.loan_documents_guard();

-- ---------------------------------------------------------------------------
-- Capability and row level security
--
-- Reading follows the loan: whoever may open a loan may see what was filed
-- with it. Writing is its own capability, matching `clients:documents` — the
-- person who files paperwork is not always the person who decides.
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('loans:documents', 'Attach or remove the supporting documents on a loan application.')
on conflict (key) do nothing;

insert into public.role_permissions (role_key, permission_key) values
  ('secretary_treasurer', 'loans:documents'),
  ('manager', 'loans:documents'),
  ('owner_admin', 'loans:documents')
on conflict (role_key, permission_key) do nothing;

alter table public.loan_documents enable row level security;

revoke all on table public.loan_documents from anon, authenticated;
grant select, insert, update, delete on table public.loan_documents to authenticated;

create policy loan_documents_select_with_permission
  on public.loan_documents for select to authenticated
  using (public.user_has_permission('loans:view'));

create policy loan_documents_insert_with_permission
  on public.loan_documents for insert to authenticated
  with check (public.user_has_permission('loans:documents'));

create policy loan_documents_update_with_permission
  on public.loan_documents for update to authenticated
  using (public.user_has_permission('loans:documents'))
  with check (public.user_has_permission('loans:documents'));

create policy loan_documents_delete_with_permission
  on public.loan_documents for delete to authenticated
  using (public.user_has_permission('loans:documents'));

-- ---------------------------------------------------------------------------
-- The bucket and its policies
--
--   loan-documents/loans/<loan_id>/<kind>/<token>.<ext>
--
-- Leading with the loan id is what makes the policies below expressible, the
-- same convention `client-documents` and `guarantor-documents` already use.
-- Private, like every bucket in this project.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'loan-documents',
  'loan-documents',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']
)
on conflict (id) do nothing;

-- The second path segment: the loan this object belongs to, or NULL when the
-- name is not shaped like one.
create or replace function public.storage_path_loan_id(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when (pg_catalog.string_to_array(p_name, '/'))[2] ~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then ((pg_catalog.string_to_array(p_name, '/'))[2])::uuid
  end;
$$;

comment on function public.storage_path_loan_id(text) is
  'Phase 13. The loan a loan-documents object belongs to, taken from its path. NULL when the path is not shaped like one, which denies the policies below.';

revoke all on function public.storage_path_loan_id(text) from public, anon;
grant execute on function public.storage_path_loan_id(text) to authenticated;

-- Reading needs `loans:view` and visibility of the loan itself. The EXISTS
-- runs under the reader's own policies, so branch scoping and the register
-- rule apply here exactly as they do on the loan page.
create policy loan_documents_read
  on storage.objects for select to authenticated
  using (
    bucket_id = 'loan-documents'
    and public.user_has_permission('loans:view')
    and exists (
      select 1 from public.loans l
      where l.id = public.storage_path_loan_id(name)
    )
  );

-- Writing needs the document capability and a loan still in draft — the same
-- rule the table's own guard enforces, repeated here because an object may be
-- written without a row ever being inserted.
create policy loan_documents_write
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'loan-documents'
    and public.user_has_permission('loans:documents')
    and public.storage_path_kind(name) in (
      'payslip', 'employment_letter',
      'trading_licence', 'bank_statement', 'business_photo',
      'guarantor_identification', 'guarantor_photograph', 'guarantor_signature',
      'supporting'
    )
    and exists (
      select 1 from public.loans l
      where l.id = public.storage_path_loan_id(name) and l.status = 'draft'
    )
  );

create policy loan_documents_remove
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'loan-documents'
    and public.user_has_permission('loans:documents')
    and exists (
      select 1 from public.loans l
      where l.id = public.storage_path_loan_id(name) and l.status = 'draft'
    )
  );

-- ---------------------------------------------------------------------------
-- The two views that read a path column now read the table
--
-- Redefined rather than left pointing at a column nothing writes, so
-- `has_payslip` keeps answering the question it was written to answer.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Three answers the brief asks for that 13.2 did not hold
--
-- A salary application should record whether the employment is permanent and
-- whether anybody checked the payslip against the employer; a business
-- application should record what the business spends as well as what it takes,
-- because an income with no costs beside it is not an assessment. Nullable,
-- because the 13.2 rows already written did not ask.
-- ---------------------------------------------------------------------------

alter table public.loan_salary_details
  add column employment_status text,
  add column salary_verification text not null default 'not_checked';

comment on column public.loan_salary_details.employment_status is
  'Phase 13. Permanent, contract, probation or casual. Null on a row captured before the question was asked.';
comment on column public.loan_salary_details.salary_verification is
  'Phase 13. Whether the stated salary was checked, and how: not_checked, payslip_seen, employer_confirmed or bank_statement.';

alter table public.loan_salary_details add constraint loan_salary_employment_status_valid
  check (employment_status is null
         or employment_status in ('permanent', 'contract', 'probation', 'casual'));

alter table public.loan_salary_details add constraint loan_salary_verification_valid
  check (salary_verification in
         ('not_checked', 'payslip_seen', 'employer_confirmed', 'bank_statement'));

alter table public.loan_business_details
  add column monthly_expenses bigint,
  add column business_contact text;

comment on column public.loan_business_details.monthly_expenses is
  'Phase 13. What the business spends in a month, in whole shillings. Optional, because a trader who has never counted it should not be made to invent a figure.';

alter table public.loan_business_details add constraint loan_business_expenses_sane
  check (monthly_expenses is null
         or (monthly_expenses >= 0 and monthly_expenses <= 10000000000));

alter table public.loan_business_details add constraint loan_business_contact_length
  check (business_contact is null
         or char_length(btrim(business_contact)) between 3 and 120);

-- ---------------------------------------------------------------------------
-- The view that read a path column now reads the table
--
-- Redefined rather than left pointing at a column nothing writes, so
-- `has_payslip` keeps answering the question it was written to answer. The
-- first eighteen columns keep their names and their order, because
-- `create or replace view` may append columns and may not rename or reorder
-- them; the new answers follow at the end.
-- ---------------------------------------------------------------------------

create or replace view public.loan_application_profile with (security_invoker = true) as
select
  l.id as loan_id,
  l.loan_number,
  l.status,
  p.product_code,
  p.name as product_name,
  p.application_profile,
  p.requires_supporting_documents,
  case p.application_profile
    when 'salary' then s.loan_id is not null
    when 'business' then b.loan_id is not null
    else true
  end as details_present,
  s.employer_name,
  s.job_title,
  s.net_monthly_salary,
  s.salary_pay_day,
  exists (
    select 1 from public.loan_documents d
    where d.loan_id = l.id and d.kind = 'payslip'
  ) as has_payslip,
  b.business_name,
  b.business_type,
  b.monthly_turnover,
  b.loan_purpose,
  exists (
    select 1 from public.loan_documents d
    where d.loan_id = l.id and d.kind = 'trading_licence'
  ) as has_trading_licence,
  s.employer_contact,
  s.staff_number,
  s.employment_started_on,
  s.employment_status,
  s.salary_verification,
  exists (
    select 1 from public.loan_documents d
    where d.loan_id = l.id and d.kind = 'employment_letter'
  ) as has_employment_letter,
  b.business_location,
  b.trading_since,
  b.monthly_expenses,
  b.business_contact,
  b.employee_count,
  b.premises_ownership,
  b.trading_licence_number,
  exists (
    select 1 from public.loan_documents d
    where d.loan_id = l.id and d.kind = 'bank_statement'
  ) as has_bank_statement,
  (
    select pg_catalog.count(*) from public.loan_documents d
    where d.loan_id = l.id
  ) as document_count
from public.loans l
join public.loan_products p on p.id = l.loan_product_id
left join public.loan_salary_details s on s.loan_id = l.id
left join public.loan_business_details b on b.loan_id = l.id;

comment on view public.loan_application_profile is
  'Phase 13. One row per loan: which product it was taken under, which questions that product asks, how they were answered, and which documents were filed.';

-- The guarantor register, on the same reasoning: a signature is now a document
-- with a kind, not a path on the row. Same column names in the same order, so
-- the replacement is accepted; two counts are appended.

create or replace view public.loan_guarantor_register with (security_invoker = true) as
select
  lg.id,
  lg.loan_id,
  l.loan_number,
  l.status as loan_status,
  l.client_id,
  case when lg.guarantor_client_id is not null then 'client' else 'external' end
    as subject_kind,
  lg.guarantor_id,
  lg.guarantor_client_id,
  coalesce(c.full_name, g.full_name) as full_name,
  coalesce(c.phone, g.phone) as phone,
  coalesce(c.alternative_phone, g.alternative_phone) as alternative_phone,
  coalesce(c.sex, g.sex) as sex,
  coalesce(c.date_of_birth, g.date_of_birth) as date_of_birth,
  coalesce(c.occupation, g.occupation) as occupation,
  coalesce(c.village_area, g.location) as location,
  coalesce(c.district, g.district) as district,
  c.client_number,
  lg.relationship_to_client,
  lg.consent_terms_id,
  lg.consent_version,
  lg.consented_at,
  lg.signature_name,
  exists (
    select 1 from public.loan_documents d
    where d.loan_guarantor_id = lg.id and d.kind = 'guarantor_signature'
  ) as has_signature_image,
  lg.witness_name,
  lg.witness_phone,
  lg.consent_place,
  lg.consented_at is not null as consent_signed,
  case
    when lg.guarantor_client_id is not null
      then exists (select 1 from public.client_identities ci
                    where ci.client_id = lg.guarantor_client_id)
    else exists (select 1 from public.guarantor_identities gi
                  where gi.guarantor_id = lg.guarantor_id)
  end as has_identification,
  lg.created_at,
  coalesce(c.business_type, g.employer_name) as employer_name,
  coalesce(coalesce(c.photo_path, g.photo_path) is not null, false) as has_photograph,
  lg.snapshot_at is not null as evidence_frozen,
  (
    select pg_catalog.count(*) from public.loan_documents d
    where d.loan_guarantor_id = lg.id
  ) as document_count
from public.loan_guarantors lg
join public.loans l on l.id = lg.loan_id
left join public.clients c on c.id = lg.guarantor_client_id
left join public.guarantors g on g.id = lg.guarantor_id;

comment on view public.loan_guarantor_register is
  'Phase 13. A loan''s guarantors with their details resolved from whichever record holds them, whether each has signed the undertaking, and what was filed with it.';

-- ---------------------------------------------------------------------------
-- The loan module's thirteen views, as one query
--
-- Draft applications, pending approval, approved, awaiting disbursement,
-- active, in grace, in arrears, cleared, refused, withdrawn, by product, and
-- the whole history. Every one of them is this view with a different `where`,
-- which is the point: a register where each tab is its own query is a register
-- where each tab eventually disagrees with the others about what "in arrears"
-- means.
--
-- ## Approved and awaiting disbursement are not the same set
--
-- The brief lists both and they are a real distinction rather than a
-- duplicate. *Approved* is every loan the business has agreed to and not yet
-- paid out. *Awaiting disbursement* is the subset whose intended date has
-- arrived — the queue somebody works through this morning, which on a Monday
-- is a quarter of the other list.
--
-- ## The collection state is joined, not recomputed
--
-- `loan_delinquency` already derives arrears, grace and days past due from the
-- schedule and the payments, under the reader's own policies. Recomputing any
-- of it here would be a second definition of arrears, and the first one to
-- drift would be the one the register showed. A reader without the capability
-- to see collections gets nulls, and the stage falls back to the lifecycle
-- status — which is honest: that reader genuinely does not know whether the
-- loan is late.
-- ---------------------------------------------------------------------------

create view public.loan_workflow_register with (security_invoker = true) as
select
  l.id as loan_id,
  l.loan_number,
  l.client_id,
  c.full_name as client_name,
  c.client_number,
  c.phone as client_phone,
  l.branch_id,
  br.name as branch_name,
  l.loan_product_id,
  p.product_code,
  p.name as product_name,
  p.application_profile,
  l.principal_amount,
  l.interest_rate_bps,
  l.interest_method,
  l.loan_term_months,
  l.repayment_frequency,
  l.total_interest,
  l.total_expected_repayment,
  l.status,
  l.closure_kind,
  l.cancellation_reason,
  l.cancelled_at,
  l.review_note,
  l.proposed_disbursement_date,
  l.submitted_at,
  l.approved_at,
  l.disbursed_at,
  l.cleared_at,
  l.created_at,
  l.updated_at,
  d.delinquency_state,
  d.arrears_amount,
  d.days_past_due,
  d.missed_installment_count,
  d.oldest_unpaid_due_date,
  d.contractual_outstanding,
  d.penalty_remaining,
  d.total_outstanding,
  d.installment_count,
  d.scheduled_completion_date,
  (select pg_catalog.count(*) from public.loan_guarantors lg
    where lg.loan_id = l.id) as guarantor_count,
  (select pg_catalog.count(*) from public.loan_guarantors lg
    where lg.loan_id = l.id and lg.consented_at is not null) as guarantor_consent_count,
  (select pg_catalog.count(*) from public.loan_documents doc
    where doc.loan_id = l.id) as document_count,
  case
    when l.status = 'draft' then 'draft'
    when l.status = 'pending_approval' then 'pending_approval'
    when l.status = 'approved'
         and l.proposed_disbursement_date <= public.business_date()
      then 'awaiting_disbursement'
    when l.status = 'approved' then 'approved'
    when l.status = 'cleared' then 'cleared'
    when l.status = 'cancelled' and l.closure_kind = 'rejected' then 'rejected'
    when l.status = 'cancelled' then 'withdrawn'
    when d.delinquency_state in ('penalty_due', 'expired_unpaid', 'in_arrears')
      then 'arrears'
    when d.delinquency_state = 'grace_period' then 'grace_period'
    else 'active'
  end as workflow_stage
from public.loans l
join public.clients c on c.id = l.client_id
join public.loan_products p on p.id = l.loan_product_id
left join public.branches br on br.id = l.branch_id
left join public.loan_delinquency d on d.loan_id = l.id;

comment on view public.loan_workflow_register is
  'Phase 13. One row per loan carrying its product, its collection state, its guarantor count and the stage of the loan workflow it sits at. The backing for every view in the loan module.';

revoke all on public.loan_workflow_register from anon, authenticated;
grant select on public.loan_workflow_register to authenticated;

-- ---------------------------------------------------------------------------
-- Who may back this application
--
-- The staff member filling in a loan form searches the client register by
-- number, name or phone and picks somebody. What they need back is not a
-- yes/no — it is the reason, because "Nakato Beatrice cannot guarantee this
-- loan" and "Nakato Beatrice already guarantees two active loans, which is the
-- limit" are a lookup apart and only the second lets them get on with their
-- morning.
--
-- So this returns every match with its reasons, and the screen shows them. It
-- is **not** the enforcement: `loan_guarantors_check_eligibility` refuses the
-- write and `validate_loan_for_approval` refuses the approval, both of them
-- re-evaluated at the moment that matters. A function that only advised, with
-- no rule behind it, would be a suggestion an API caller could ignore; a rule
-- with no advice in front of it is a form that refuses without saying why.
--
-- SECURITY INVOKER, deliberately: a caller sees exactly the clients their own
-- policies let them see, and no more.
-- ---------------------------------------------------------------------------

create or replace function public.guarantor_candidates(
  p_loan_id uuid,
  p_search  text default null
)
returns table (
  client_id uuid,
  client_number text,
  full_name text,
  phone text,
  occupation text,
  location text,
  district text,
  status text,
  has_identification boolean,
  active_loan_count integer,
  arrears_amount bigint,
  guaranteeing_count integer,
  already_attached boolean,
  eligible boolean,
  reasons text[]
)
language sql
stable
set search_path = ''
as $$
  with settings as (
    select * from public.business_settings where id = 1
  ),
  loan as (
    select l.id, l.client_id from public.loans l where l.id = p_loan_id
  ),
  term as (
    select pg_catalog.btrim(coalesce(p_search, '')) as q
  ),
  candidate as (
    select
      c.id, c.client_number, c.full_name, c.phone, c.occupation,
      c.village_area, c.district, c.status, c.date_of_birth,
      exists (select 1 from public.client_identities ci where ci.client_id = c.id)
        as has_identification,
      (select pg_catalog.count(*)::integer from public.loans l2
        where l2.client_id = c.id and l2.status = 'active') as active_loan_count,
      coalesce((
        select pg_catalog.sum(dq.arrears_amount)::bigint
        from public.loan_delinquency dq
        join public.loans l3 on l3.id = dq.loan_id
        where l3.client_id = c.id and l3.status = 'active'
      ), 0) as arrears_amount,
      (select pg_catalog.count(*)::integer
        from public.loan_guarantors lg
        join public.loans l4 on l4.id = lg.loan_id
        where lg.guarantor_client_id = c.id and l4.status = 'active')
        as guaranteeing_count,
      exists (
        select 1 from public.loan_guarantors lg
        where lg.loan_id = p_loan_id and lg.guarantor_client_id = c.id
      ) as already_attached
    from public.clients c, term t
    where c.archived_at is null
      and (
        t.q = ''
        or c.full_name ilike '%' || t.q || '%'
        or c.client_number ilike '%' || t.q || '%'
        or c.phone like '%' || t.q || '%'
      )
  ),
  judged as (
    select
      cand.*,
      (
        -- The order is the order a person would say them in: who they are
        -- first, then what the business has decided about them, then what
        -- they are already carrying.
        case when (select l.client_id from loan l) = cand.id
          then array['is_borrower'] else array[]::text[] end
        || case when cand.already_attached
          then array['already_attached'] else array[]::text[] end
        || case when not (select s.allow_client_as_guarantor from settings s)
          then array['clients_not_allowed'] else array[]::text[] end
        || case when cand.status <> 'active'
          then array['not_active_' || cand.status] else array[]::text[] end
        || case when cand.date_of_birth >
                     (current_date
                      - ((select s.guarantor_min_age_years from settings s) || ' years')::interval)
          then array['underage'] else array[]::text[] end
        || case when not cand.has_identification
          then array['no_identification'] else array[]::text[] end
        || case when cand.active_loan_count > 0
          then array['has_active_loan'] else array[]::text[] end
        || case when cand.arrears_amount > 0
          then array['in_arrears'] else array[]::text[] end
        || case when cand.guaranteeing_count
                     >= (select s.guarantor_max_active_loans from settings s)
          then array['guarantee_limit'] else array[]::text[] end
      ) as reasons
    from candidate cand
  )
  select
    j.id, j.client_number, j.full_name, j.phone, j.occupation,
    j.village_area, j.district, j.status,
    j.has_identification, j.active_loan_count, j.arrears_amount,
    j.guaranteeing_count, j.already_attached,
    pg_catalog.cardinality(j.reasons) = 0 as eligible,
    j.reasons
  from judged j
  order by (pg_catalog.cardinality(j.reasons) = 0) desc, j.full_name
  limit 50;
$$;

comment on function public.guarantor_candidates(uuid, text) is
  'Phase 13. The existing clients who could back a given application, each with the reasons they may not. Advice for the screen; loan_guarantors_check_eligibility and validate_loan_for_approval remain the enforcement.';

revoke all on function public.guarantor_candidates(uuid, text) from public, anon;
grant execute on function public.guarantor_candidates(uuid, text) to authenticated;
