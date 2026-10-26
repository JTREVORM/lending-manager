-- ===========================================================================
-- Polytos Phase 4.1 — the benefit, beneficiary and meeting capabilities
--
-- ## Why a benefit takes five capabilities and a meeting takes two
--
-- A benefit is money leaving the business on the strength of a document
-- somebody produced. Nobody in this building saw the admission, nobody
-- attended the funeral, and the invoice is a photograph. So the act is split
-- into the four distinct judgements it actually contains, each held by
-- somebody who can refuse the one before it:
--
--   `benefits:claim`    somebody says this happened, and attaches evidence
--   `benefits:assess`   somebody checks the evidence against the policy and
--                       computes what is payable
--   `benefits:approve`  somebody independently agrees, on the assessment
--   `benefits:pay`      somebody moves the money
--
-- Plus `benefits:view`, which opens the register without opening any of them.
--
-- This is the shape savings already uses for a withdrawal — prepare, decide,
-- pay — with one more stage, because a withdrawal returns a member their own
-- money and a benefit spends the company's. And as with a withdrawal, the
-- split is a *control* rather than a label: `approve_benefit_claim` refuses an
-- approval from the person who assessed it, so a Manager holding both keys
-- still cannot do both halves of one claim. Nothing on this page is what makes
-- that true; 20261022000700 is.
--
-- A meeting is minutes and a register of who came. It takes `meetings:view`
-- and `meetings:manage`, because scheduling a meeting and recording who
-- attended are the same kind of act — clerical, reversible, and about no
-- money at all.
--
-- ## `membership:view_sensitive` arrives here, with the table it guards
--
-- Phase 1 deliberately declined to declare it: the Phase 1 schema held no
-- personal data of its own, so the capability would have promised a
-- restriction over nothing. `member_beneficiaries` is that data — a named
-- third party, their phone number, their relationship to a member, and an
-- identity reference where approved procedure requires one — and it is the
-- business's **payment instruction** for the bereavement benefit.
--
-- So the capability is real now, and it is deliberately narrow:
--
--   `beneficiaries:view`    see that a member has a registered next of kin,
--                           their relationship, and the verification state
--   `beneficiaries:manage`  register one, or request a change
--   `beneficiaries:verify`  confirm a beneficiary's record against evidence
--   `membership:view_sensitive`
--                           see the contact and identity details themselves
--
-- Four, not one, because "this member has a verified next of kin" is what an
-- assessor needs to decide a claim, and "her telephone number is X and her
-- identity document says Y" is what a payer needs to hand over cash. The
-- first question is asked constantly; the second rarely. A single capability
-- would answer both, which would put a payment instruction in front of
-- everybody who reads the register.
--
-- Registering and verifying are split for the same reason assessing and
-- approving are. A beneficiary is who gets UGX 200,000 when a member dies. A
-- member of staff who could both create that record and attest to it could
-- name themselves a beneficiary of a member they expect to die — which is not
-- a hypothetical fraud, it is the obvious one, and the one the client's own
-- documents ask for "verification" to stop. `verify_member_beneficiary`
-- refuses a verification from the person who recorded it.
--
-- ## What is deliberately not here
--
-- **No `benefits:reverse`.** A benefit payment reversal rewrites what the
-- books say happened, and it takes `savings:reverse` — the Owner's alone,
-- already the capability that covers every other reversal of a posted
-- movement in this programme. A fifth benefit capability over the same class
-- of act would be a second answer to "who may un-say a payment". See
-- 20261022000800.
--
-- **No `benefits:manage_policy`.** The medical rate, the cap, the claim
-- frequency, the waiting period and the two fixed amounts are columns on
-- `membership_policy_versions`, behind `membership:manage_policies` — the
-- Owner's. A second capability over the same columns would be a lock with two
-- keys.
--
-- **No `meetings:attend`.** Attendance is recorded *by staff about members*,
-- not by the member; a member has no account that could mark themselves
-- present, and inventing one would be inventing a self-service meeting
-- register nobody asked for.
--
-- **No benefit capability for a member.** A member reads their own claims and
-- their own beneficiaries through the identity clause on `clients.profile_id`,
-- which grants exactly their own rows — the same route their savings take. A
-- capability granted to the `client` role would grant the whole register.
-- ===========================================================================

insert into public.permissions (key, description)
values
  -- --- Beneficiaries -----------------------------------------------------
  ('beneficiaries:view',
   'See that a member has a registered next of kin, the relationship, and whether the record has been verified.'),
  ('beneficiaries:manage',
   'Register a member''s beneficiary, or request a change to one.'),
  ('beneficiaries:verify',
   'Confirm a beneficiary record against the evidence supplied. Never the person who recorded it.'),
  ('membership:view_sensitive',
   'See a beneficiary''s contact details and identity reference — the payment instruction itself, not merely that one exists.'),

  -- --- Benefit claims ----------------------------------------------------
  ('benefits:view',
   'See the benefit claim register, a claim and its history.'),
  ('benefits:claim',
   'Open a benefit claim for a member and attach the evidence supplied.'),
  ('benefits:assess',
   'Check a claim''s evidence against the governing policy and record what is payable.'),
  ('benefits:approve',
   'Approve or refuse an assessed claim. Never the person who assessed it.'),
  ('benefits:pay',
   'Pay an approved benefit and post it to the ledger.'),

  -- --- Meetings ----------------------------------------------------------
  ('meetings:view',
   'See the membership meeting calendar, a meeting, its minutes and its attendance register.'),
  ('meetings:manage',
   'Schedule, reschedule or cancel a membership meeting, record attendance, and write its minutes and actions.')
on conflict (key) do update set description = excluded.description;

-- ---------------------------------------------------------------------------
-- Who holds what
--
-- Read the four benefit stages down the columns rather than across the roles:
-- each role holds at most two adjacent stages, so no single role can carry a
-- claim from submission to cash.
--
--                        claim  assess  approve  pay
--   Secretary/Treasurer    x       -       -      -
--   Manager                x       x       -      x
--   Owner/Admin            x       x       x      x
--
-- The Owner holds everything, as they do everywhere else here — and the
-- function-level refusal is what stops them being both the assessor and the
-- approver of one claim. That is the only arrangement that works in a
-- business this size: a rule that *no* person may hold both keys would make a
-- claim unapprovable on any day the one other key-holder is out.
-- ---------------------------------------------------------------------------

insert into public.role_permissions (role_key, permission_key)
values
  -- --- Secretary/Treasurer ----------------------------------------------
  --
  -- The counter. They are the person a bereaved family walks up to, so they
  -- open the claim and take the documents; they read the register to answer
  -- "has my claim been decided?"; and they register beneficiaries, because
  -- next of kin is collected at enrolment and at the counter afterwards.
  --
  -- They do not verify a beneficiary they recorded, do not assess, do not
  -- approve and do not pay. They hold `beneficiaries:view` but **not**
  -- `membership:view_sensitive`: knowing that a member has a verified next of
  -- kin is counter work, and reading that person's phone number and identity
  -- reference is not.
  ('secretary_treasurer', 'beneficiaries:view'),
  ('secretary_treasurer', 'beneficiaries:manage'),
  ('secretary_treasurer', 'benefits:view'),
  ('secretary_treasurer', 'benefits:claim'),
  ('secretary_treasurer', 'meetings:view'),
  ('secretary_treasurer', 'meetings:manage'),

  -- --- Manager -----------------------------------------------------------
  --
  -- Supervises the programme: verifies beneficiary records, assesses claims
  -- and pays approved ones. Not `benefits:approve` — that is the independent
  -- judgement above the assessment, and giving a Manager both would make the
  -- separation depend entirely on the function refusing them, with nothing
  -- behind it if that refusal were ever relaxed.
  --
  -- `membership:view_sensitive`, because an assessor has to look at who the
  -- business is about to pay and a payer has to hand over the money.
  ('manager', 'beneficiaries:view'),
  ('manager', 'beneficiaries:manage'),
  ('manager', 'beneficiaries:verify'),
  ('manager', 'membership:view_sensitive'),
  ('manager', 'benefits:view'),
  ('manager', 'benefits:claim'),
  ('manager', 'benefits:assess'),
  ('manager', 'benefits:pay'),
  ('manager', 'meetings:view'),
  ('manager', 'meetings:manage'),

  -- --- Owner/Admin -------------------------------------------------------
  ('owner_admin', 'beneficiaries:view'),
  ('owner_admin', 'beneficiaries:manage'),
  ('owner_admin', 'beneficiaries:verify'),
  ('owner_admin', 'membership:view_sensitive'),
  ('owner_admin', 'benefits:view'),
  ('owner_admin', 'benefits:claim'),
  ('owner_admin', 'benefits:assess'),
  ('owner_admin', 'benefits:approve'),
  ('owner_admin', 'benefits:pay'),
  ('owner_admin', 'meetings:view'),
  ('owner_admin', 'meetings:manage')
on conflict (role_key, permission_key) do nothing;

-- A borrower holds none of these. Their own claims and their own beneficiary
-- records reach them through `clients.profile_id`, which grants exactly their
-- own rows; see 20261022001100. Their *internal assessment notes* do not
-- reach them at all, because nobody has approved a client-facing disclosure
-- policy for an assessor's working reasoning.

-- ---------------------------------------------------------------------------
-- The Phase 4 reference scopes
--
-- Each minted by `public.next_reference()` inside a BEFORE INSERT trigger,
-- exactly as `MB`, `SA` and `WD` are — never `MAX(number) + 1`, which under
-- two concurrent counter staff issues one number twice.
--
-- `BC` with padding 5 is the roadmap's proposal and the right shape: a claim
-- is an internal document like a withdrawal request, so it follows `WD`'s
-- width rather than the member-facing `MB`/`SA` four.
--
-- `BN` for a beneficiary record, because a beneficiary change produces a
-- *second* record superseding the first (see 20261022000300) and the two have
-- to be distinguishable on paper — "the beneficiary we verified" is a
-- reference, not a name.
--
-- `BP` for a payment, separate from `BC`: the claim is the request and the
-- payment is the receipt the recipient signs for, and one claim can in
-- principle be paid and reversed and paid again.
--
-- `MM` for a meeting. Four, like `MB`, because it is quoted in minutes that
-- people read.
-- ---------------------------------------------------------------------------

insert into public.reference_formats (scope, prefix, padding, description)
values
  ('benefit_claim', 'BC', 5,
   'Benefit claims — medical, family condolence, member bereavement, e.g. BC2600001'),
  ('beneficiary', 'BN', 5,
   'Member beneficiary records, e.g. BN2600001'),
  ('benefit_payment', 'BP', 5,
   'Benefit payment receipts, e.g. BP2600001'),
  ('membership_meeting', 'MM', 4,
   'Membership meetings, e.g. MM260001')
on conflict (scope) do nothing;
