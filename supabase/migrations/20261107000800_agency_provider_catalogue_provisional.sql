-- ===========================================================================
-- Phase 4A — Agency Banking & Digital Payments: the provisional provider
-- catalogue
--
-- Specification: `docs/AGENCY-BANKING-ARCHITECTURE.md` v3.0, §4 and §12
-- Step 7.
--
-- ## This migration encodes an OPEN business decision, and says so in the data
--
-- `commission_model` decides whether commission is recognised at the point of
-- sale or accrued to 1310 and cleared when the provider remits. It changes the
-- journal posted for every transaction of that provider, so it is a business
-- rule rather than a technical choice — and it has not been confirmed
-- (reconciliation §4, decision C).
--
-- The Product Owner's instruction was to build the structure now and seed the
-- catalogue provisionally, so every row here carries `is_provisional = true`.
-- The values are the specification's §4.1 defaults and nothing more. Nothing
-- in the engine reads the flag; it exists so that a catalogue nobody has
-- approved cannot be mistaken for one that has been, and so the open decision
-- is visible in the data rather than only in a document.
--
-- **Confirming a provider is a data change, not a migration.** When the model
-- for a provider is settled, update its row and clear the flag. That is the
-- whole reason the catalogue is separate from the schema: no part of the
-- structure depends on which answer is given.
--
-- `commission_rate` and `commission_fixed` are left NULL throughout. Rates are
-- commercially negotiated per provider and nobody has supplied them; a plausible
-- guess here would be indistinguishable from a real figure once it was in the
-- table, and would silently price every transaction. The Phase 4B engine takes
-- the commission as an explicit input, so a NULL rate blocks nothing.
--
-- No float tills are provisioned. Which providers are live at which branch is
-- the specification's own open item (§13, risk 3), and
-- `ensure_agency_float_account()` creates them one at a time when that is known.
-- ===========================================================================

insert into public.agency_service_providers
  (code, name, category, float_model, payable_account_id, income_account_id,
   commission_model, is_provisional, is_active)
values
  -- --- Mobile money: the agent holds float the provider advanced -----------
  ('MTN_MOMO', 'MTN Mobile Money', 'mobile_money', 'provider_float', null,
   (select id from public.ledger_accounts where code = '4510'), 'deferred', true, true),
  ('AIRTEL_MONEY', 'Airtel Money', 'mobile_money', 'provider_float', null,
   (select id from public.ledger_accounts where code = '4510'), 'deferred', true, true),

  -- --- Utilities: paid out of float, commission remitted later ------------
  -- UEDCL, not UMEME (correction C12): UEDCL is the distributor and Yaka is
  -- its prepaid product.
  ('UEDCL', 'UEDCL Yaka Electricity', 'utility', 'provider_float', null,
   (select id from public.ledger_accounts where code = '4530'), 'deferred', true, true),
  ('NWSC', 'NWSC Water', 'utility', 'provider_float', null,
   (select id from public.ledger_accounts where code = '4530'), 'deferred', true, true),

  -- --- TV subscriptions ---------------------------------------------------
  ('DSTV', 'DStv', 'tv_subscription', 'provider_float', null,
   (select id from public.ledger_accounts where code = '4550'), 'deferred', true, true),
  ('GOTV', 'GOtv', 'tv_subscription', 'provider_float', null,
   (select id from public.ledger_accounts where code = '4550'), 'deferred', true, true),

  -- --- Airtime and data: the one immediate-commission category ------------
  -- Correction C12 classifies Lycamobile here rather than as mobile money.
  ('LYCAMOBILE', 'Lycamobile Airtime & Data', 'airtime_data', 'provider_float', null,
   (select id from public.ledger_accounts where code = '4560'), 'immediate', true, true),

  -- --- Agency banking: the company holds the customer's cash and owes the
  -- --- bank, so this is cash_payable against 2220 rather than float --------
  ('STANBIC', 'Stanbic Bank Agency', 'agency_banking', 'cash_payable',
   (select id from public.ledger_accounts where code = '2220'),
   (select id from public.ledger_accounts where code = '4520'), 'deferred', true, true),

  -- --- School fees: collected for an institution, owed onward via 2210 ----
  -- §12 Step 7 lists eight providers and no school, but Phase 4B must support
  -- school fees collection, so a generic institution provider is seeded for
  -- the engine to exercise. A real deployment adds one row per institution.
  ('SCHOOL_FEES', 'School Fees Collection', 'school_fees', 'cash_payable',
   (select id from public.ledger_accounts where code = '2210'),
   (select id from public.ledger_accounts where code = '4540'), 'deferred', true, true)
on conflict (code) do nothing;


-- ---------------------------------------------------------------------------
-- Transaction types
--
-- `direction` is from the customer's point of view. A `deposit` is the
-- customer handing cash over the counter; a `withdrawal` is the customer
-- taking cash out; a `payment` is the customer settling a bill with a third
-- party.
--
-- The identifier each type demands is what the counter clerk must capture for
-- the transaction to be traceable: a phone number for mobile money, a meter
-- number for Yaka, an account number for water and TV, a student number for
-- school fees.
--
-- No limits or approval ceilings are set. `max_single_transaction` and
-- `requires_approval_above` are commercial and risk decisions nobody has
-- stated, and NULL means "no limit" rather than "zero" — so leaving them unset
-- blocks nothing and invents nothing.
-- ---------------------------------------------------------------------------

insert into public.agency_transaction_types
  (provider_id, code, name, direction,
   requires_meter_number, requires_account_number, requires_customer_name)
select p.id, t.code, t.name, t.direction,
       t.meter, t.account_no, t.cust_name
from public.agency_service_providers p
join (values
  ('MTN_MOMO',     'DEPOSIT',    'MoMo Deposit',           'deposit',    false, true,  false),
  ('MTN_MOMO',     'WITHDRAWAL', 'MoMo Withdrawal',        'withdrawal', false, true,  false),
  ('AIRTEL_MONEY', 'DEPOSIT',    'Airtel Money Deposit',   'deposit',    false, true,  false),
  ('AIRTEL_MONEY', 'WITHDRAWAL', 'Airtel Money Withdrawal','withdrawal', false, true,  false),
  ('UEDCL',        'YAKA',       'Yaka Electricity Token', 'payment',    true,  false, false),
  ('NWSC',         'WATER_BILL', 'NWSC Water Bill',        'payment',    false, true,  false),
  ('DSTV',         'SUBSCRIPTION','DStv Subscription',     'payment',    false, true,  false),
  ('GOTV',         'SUBSCRIPTION','GOtv Subscription',     'payment',    false, true,  false),
  ('LYCAMOBILE',   'AIRTIME',    'Airtime Top-up',         'payment',    false, true,  false),
  ('LYCAMOBILE',   'DATA',       'Data Bundle',            'payment',    false, true,  false),
  ('STANBIC',      'DEPOSIT',    'Bank Agency Deposit',    'deposit',    false, true,  true),
  ('STANBIC',      'WITHDRAWAL', 'Bank Agency Withdrawal', 'withdrawal', false, true,  true),
  ('SCHOOL_FEES',  'FEES',       'School Fees Payment',    'payment',    false, true,  true)
) as t(provider_code, code, name, direction, meter, account_no, cust_name)
  on t.provider_code = p.code
on conflict (provider_id, code) do nothing;


-- ---------------------------------------------------------------------------
-- The low-float warning threshold
--
-- §12 Step 7's third item. The column already defaults to 200,000, so this is
-- a no-op on a fresh database and exists only so an existing row that predates
-- the column is not left below the intended default.
-- ---------------------------------------------------------------------------

update public.finance_settings
   set low_balance_agency_float = 200000
 where id = 1 and low_balance_agency_float is distinct from 200000;
