-- ===========================================================================
-- POLYTOS DEMONSTRATION ENTERPRISE — demonstration organisation identity
--
-- Applied to the throwaway documentation database only (the Docker-free e2e
-- harness stack: PostgreSQL on 127.0.0.1:5433, database `lending_e2e`).
-- NEVER run this against a hosted or production project.
--
-- Everything below is invented. No real business, person, telephone number,
-- bank account or agent number appears anywhere in this file.
--
-- ## Why the two additional branches are inserted here rather than created
-- ## in the application
--
-- The Branches panel at Settings → Branch network is READ-ONLY in this
-- release: `branches:create` and `branches:update` are declared in the
-- permission matrix and granted to the Owner / Administrator, but no screen
-- and no Server Action calls them, and a branch's five ledger accounts have
-- no creation screen either (`finance:accounts` is likewise granted and
-- unused). Branch provisioning is therefore an implementation-team task in
-- this release, performed exactly as below. This is recorded as finding
-- F-01 in 06-Findings/FINDINGS_AND_GAPS.md.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The organisation
-- ---------------------------------------------------------------------------
update public.company_settings
   set company_name        = 'POLYTOS Demonstration Enterprise',
       legal_name          = 'POLYTOS Demonstration Enterprise Limited',
       registration_number = 'DEMO-0000000',
       phone               = '+256772900100',
       email               = 'office@polytos-demo.invalid',
       address_line1       = 'Plot 27, Kampala Road',
       address_line2       = 'Second Floor, Demonstration House',
       city                = 'Kampala',
       receipt_header      = 'POLYTOS Demonstration Enterprise — Official Receipt',
       receipt_footer      = 'Thank you. Keep this receipt for your records.'
 where id = 1;

-- ---------------------------------------------------------------------------
-- 2. Kampala Main Branch — the branch the baseline already provisioned
-- ---------------------------------------------------------------------------
update public.branches
   set name     = 'Kampala Main Branch',
       location = 'Plot 27, Kampala Road',
       district = 'Kampala',
       phone    = '+256772900101',
       email    = 'kampala@polytos-demo.invalid'
 where branch_code = 'BR2601';

update public.ledger_accounts
   set name = replace(name, '— Head Office', '— Kampala Main')
 where branch_id = (select id from public.branches where branch_code = 'BR2601');

-- ---------------------------------------------------------------------------
-- 3. Mbarara and Masaka — two further trading branches
--
-- Each branch owns the same five money accounts the Phase 10 baseline gave
-- Kampala Main: cash at hand, the business's own MTN and Airtel wallets, a
-- bank account and a cash-in-transit account. The unique indexes
-- `ledger_accounts_one_wallet_per_branch` and
-- `ledger_accounts_one_transit_per_branch` permit exactly one of each per
-- branch, which is what this creates.
-- ---------------------------------------------------------------------------
insert into public.branches
  (branch_code, name, location, district, phone, email, status, opened_on, notes)
values
  ('BR2602', 'Mbarara Branch', 'Plot 8, High Street', 'Mbarara',
   '+256772900102', 'mbarara@polytos-demo.invalid', 'active', date '2026-02-02',
   'Demonstration branch. Trades mobile money and agency banking.'),
  ('BR2603', 'Masaka Branch', 'Plot 3, Elgin Street', 'Masaka',
   '+256772900103', 'masaka@polytos-demo.invalid', 'active', date '2026-04-13',
   'Demonstration branch. Trades mobile money only.')
on conflict (branch_code) do nothing;

insert into public.ledger_accounts
  (code, name, account_type, normal_side, cash_kind, branch_id,
   institution, account_number, is_postable, parent_id, status, description)
select
  a.prefix || '-' || b.branch_code,
  a.label || ' — ' || replace(b.name, ' Branch', ''),
  'asset', 'debit', a.kind, b.id,
  a.institution, a.account_number, true,
  (select id from public.ledger_accounts where code = '1000'),
  'active',
  'Provisioned for the documentation demonstration organisation.'
  from public.branches b
 cross join (values
   ('1010', 'Cash at Hand',      'cash_at_hand',     null,              null),
   ('1020', 'MTN Mobile Money',  'mtn_mobile_money', null,              null),
   ('1030', 'Airtel Money',      'airtel_money',     null,              null),
   ('1040', 'Cash at Bank',      'bank',             'Centenary Bank',  '0100000000000'),
   ('1050', 'Cash in Transit',   'in_transit',       null,              null)
 ) as a(prefix, label, kind, institution, account_number)
 where b.branch_code in ('BR2602', 'BR2603')
on conflict (code) do nothing;

commit;
