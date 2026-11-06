# POLYTOS Agency Banking & Digital Payments — Architecture Specification
## Version 3.0 · Final Corrected · 2026-11-01

> **Status: AWAITING APPROVAL — do not implement until explicitly authorised**
> Security PR #18 remains open, unmerged, and is separate from this work.
> Production migrations, Policy 2.0, and demo data are unaffected.

---

## Table of Contents

1. [Corrections Applied (v2 → v3)](#1-corrections-applied)
2. [Verified Production Baseline](#2-verified-production-baseline)
3. [Account Code Allocation](#3-account-code-allocation)
4. [Provider & Service Catalogue](#4-provider--service-catalogue)
5. [Data Model](#5-data-model)
6. [Journal Matrix](#6-journal-matrix)
7. [State Machine](#7-state-machine)
8. [Posting Functions](#8-posting-functions)
9. [Permission Model](#9-permission-model)
10. [Views & Reports](#10-views--reports)
11. [Test Suite](#11-test-suite)
12. [Migration Checklist](#12-migration-checklist)
13. [GO / NO-GO Recommendation](#13-go--no-go-recommendation)

---

## 1. Corrections Applied

All 13 user corrections from the round-2 review are addressed here.

| # | Issue | Resolution |
|---|-------|-----------|
| C1 | `2000` (Liabilities heading), `2100` (Member Savings), `4400` (Meeting Fine Income) already exist | Use **2200-series** for payables, **4500-series** for income. All new codes verified free against production. |
| C2 | `record_transfer()` requires both accounts to be cash accounts (`cash_kind IS NOT NULL`); cannot settle liability payables | Dedicated `post_agency_payable_settlement()` function; does not call `record_transfer()`. |
| C3 | T-13 tested insufficient float on a withdrawal; should test the credited (decreasing) account | T-13a: deposit fails when **float** is insufficient. T-13b: withdrawal fails when **Cash at Hand** is insufficient. |
| C4 | `allow_negative_cash` cannot be accidentally applied to agency float | Explicit `allow_negative_agency_float boolean not null default false` column on `finance_settings`. New `assert_agency_float_available()` reads only that column. |
| C5 | Reversal `source_type` values did not follow the existing `_reversal` suffix convention | New values: `agency_transaction`, `agency_transaction_reversal`, `agency_commission_settlement`, `agency_payable_settlement`, `agency_payable_settlement_reversal`. |
| C6 | Reference-entry correction and financial reversal were conflated | `update_agency_transaction_reference()` for metadata correction (no journal); `reverse_agency_transaction()` for financial reversals only. |
| C7 | `commission_immediate` flag and partial-settlement semantics were underspecified | `commission_model` column on `agency_transaction_types`: `'deferred'` (accrual → receivable → settle) or `'immediate'` (recognize at point of sale). Partial settlement tracked per settlement batch. Double-recognition prevented by checking receivable balance before settlement. |
| C8 | Commission report view excluded reversal contra entries | View uses `SUM(credit) - SUM(debit)` across all `agency_transaction*` source types; reversals reduce the net naturally. |
| C9 | Single reconciliation table conflated cash-till and electronic float | Two separate tables: `agency_cash_reconciliations` (physical cash vs. ledger 1010) and `agency_float_reconciliations` (system float vs. provider statement). |
| C10 | T-S06 forbade any change to Cash at Hand, which is intentionally shared | T-S06 now asserts only lending-specific accounts (1200, 4100, 4200) are unchanged; Cash at Hand may legitimately move. |
| C11 | `transfer_reversal` listed as a possible gap to repair | Confirmed present in production constraint. No repair. |
| C12 | "UMEME/Yaka" used for electricity provider | Corrected to **UEDCL** (Uganda Electricity Distribution Company Limited, Yaka prepaid). Lycamobile classified as `airtime_data`, `commission_model = 'immediate'`. |
| C13 | One float account per provider per branch; no multiple-till support | `agency_provider_float_accounts` supports multiple rows per provider+branch via `till_name`. Transactions reference `float_account_id` directly. |

---

## 2. Verified Production Baseline

All facts in this section were confirmed by direct SQL query against production project `fszgwemtgyrbhngajpzm`.

### 2.1 Existing Chart of Accounts (relevant subset)

| Code | Name | Type | cash_kind | is_postable |
|------|------|------|-----------|-------------|
| 1010-BR2601 | Cash at Hand | asset | cash_at_hand | true |
| 1020-BR2601 | MTN Mobile Money | asset | mtn_mobile_money | true |
| 1030-BR2601 | Airtel Money | asset | airtel_money | true |
| 1040-BR2601 | Cash at Bank | asset | bank | true |
| 1200 | Loans Receivable | asset | — | true |
| **2000** | **Liabilities** | liability | — | **false (heading)** |
| **2100** | **Member Savings** | liability | — | **true — TAKEN** |
| 3000 | Owner Capital | equity | — | false (heading) |
| 4000 | Income | income | — | false (heading) |
| 4100 | Interest Income | income | — | true |
| 4200 | Penalty Income | income | — | true |
| 4300–4340 | Fee Income (5 accounts) | income | — | true |
| **4400** | **Meeting Fine Income** | income | — | **true — TAKEN** |
| 4900 | Other Income | income | — | true |
| 5000 | Operating Expenses | expense | — | false (heading) |
| 5010–5100 | Expense accounts (10) | expense | — | true |
| 5200 | Member Benefits | expense | — | false (heading) |
| 5210–5230 | Benefit accounts (3) | expense | — | true |
| 5900 | Other Expenses | expense | — | true |
| 5950 | Cash Over and Short | expense | — | true |

All 1300-series, 2200-2900, 4500-4890, and 5960+ codes are **free and confirmed unoccupied**.

### 2.2 Existing `source_type` Constraint (21 values)

```
'opening_balance', 'loan_disbursement', 'loan_repayment', 'payment_reversal',
'penalty_charge', 'transfer', 'transfer_reversal', 'expense', 'expense_reversal',
'other_income', 'other_income_reversal', 'reconciliation_adjustment', 'adjustment',
'membership_fee', 'membership_fee_reversal', 'savings_deposit',
'savings_deposit_reversal', 'savings_withdrawal', 'savings_withdrawal_reversal',
'benefit_payment', 'benefit_payment_reversal'
```

`transfer_reversal` IS already present (correction C11). The `_reversal` suffix pattern is the established convention.

### 2.3 `cash_kind` Constraint (4 values)

```
'cash_at_hand', 'mtn_mobile_money', 'airtel_money', 'bank'
```

`agency_float` must be added. The `ledger_accounts_one_wallet_per_branch` unique index covers only `cash_at_hand`, `mtn_mobile_money`, `airtel_money` — `bank` and the new `agency_float` are **not** in it, which correctly allows multiple float accounts per branch.

### 2.4 `finance_settings` Existing Columns

```
id, transfer_approval_threshold, expense_approval_threshold,
allow_negative_cash, reconciliation_requires_review,
low_balance_cash_at_hand, low_balance_mtn_mobile_money,
low_balance_airtel_money, low_balance_bank,
created_at, updated_at, updated_by
```

New columns required: `allow_negative_agency_float boolean not null default false`, `low_balance_agency_float bigint not null default 200000`.

### 2.5 Existing Helper Function Signatures

| Function | Signature | SECURITY |
|----------|-----------|----------|
| `assert_cash_account` | `(p_account_id uuid, p_role text)` | DEFINER |
| `assert_cash_available` | `(p_account_id uuid, p_amount bigint)` | DEFINER |
| `assert_postable_account` | `(p_account_id uuid, p_type text, p_role text)` | DEFINER |
| `post_journal` | `(p_branch_id, p_entry_date, p_description, p_source_type, p_source_id, p_loan_id, p_client_id, p_lines jsonb, [p_posted_at], [p_created_by], [p_created_by_label])` | DEFINER |

`assert_agency_float_available()` is a new function (below); it must NOT call `assert_cash_available()`.

---

## 3. Account Code Allocation

### 3.1 New Asset Accounts

| Code | Name | Type | cash_kind | is_postable | Notes |
|------|------|------|-----------|-------------|-------|
| 1300 | Agency Services Assets | asset | — | false | Heading |
| 1310 | Agency Commission Receivable | asset | — | true | Deferred commission accrual |
| 1320 | Agency Float Accounts | asset | — | false | Heading |
| 1320.{PROVIDER}.{BRANCH} | {Provider} Float — {Branch} | asset | agency_float | true | One per provider × branch × till; code format e.g. `1320.MTN.BR2601` or `1320.MTN.BR2601.T2` |

Individual float account codes follow the pattern already used by cash accounts: base code + dot-separated provider code + branch code. Multiple tills append `.T2`, `.T3`, etc.

### 3.2 New Liability Accounts (under existing `2000` heading)

| Code | Name | Type | cash_kind | is_postable | Notes |
|------|------|------|-----------|-------------|-------|
| 2200 | Agency Service Payables | liability | — | false | Heading (under 2000) |
| 2210 | School Fees Payable | liability | — | true | Collected and due to institutions |
| 2220 | Bank Agency Payable | liability | — | true | Net settlement due to partner bank |
| 2290 | Other Agency Payables | liability | — | true | Catch-all for configurable providers |

### 3.3 New Income Accounts (under existing `4000` heading)

| Code | Name | Type | cash_kind | is_postable | Notes |
|------|------|------|-----------|-------------|-------|
| 4500 | Agency Services Income | income | — | false | Heading (between 4400 and 4900) |
| 4510 | Mobile Money Commission | income | — | true | MTN MoMo + Airtel Money |
| 4520 | Agency Banking Commission | income | — | true | Stanbic, PostBank, etc. |
| 4530 | Utility Commission | income | — | true | UEDCL Yaka, NWSC water |
| 4540 | School Fees Commission | income | — | true | Handling fee retained |
| 4550 | TV Subscription Commission | income | — | true | DStv, GOtv, StarTimes, Azam |
| 4560 | Airtime & Data Commission | income | — | true | MTN, Airtel, Lycamobile, Uganda Telecom |
| 4570 | Agency Service Fees | income | — | true | Convenience fees charged to customers |
| 4590 | Other Agency Commission | income | — | true | Configurable providers |

### 3.4 New Expense Account

| Code | Name | Type | is_postable | Notes |
|------|------|------|-------------|-------|
| 5960 | Agency Float Over and Short | expense | true | Electronic float variance write-off; kept separate from 5950 (cash till) |

### 3.5 Accounts Not Created Per-Provider

Commission income is recognised by **income account code** (e.g. 4510 for all mobile money providers), not by creating separate accounts per provider. Provider-level granularity is available through the journal's `source_id` (pointing to the agency transaction) and the reporting view (§10.2).

---

## 4. Provider & Service Catalogue

### 4.1 Provider Categories and Commission Models

| Category | `commission_model` | Providers (configurable) | Payable Account |
|----------|--------------------|--------------------------|-----------------|
| `mobile_money` | `deferred` | MTN MoMo, Airtel Money | Float (no payable) |
| `agency_banking` | `deferred` | Stanbic, PostBank, DFCU | 2220 |
| `utility` | `deferred` | UEDCL (Yaka), NWSC Water | Float (no payable) |
| `school_fees` | `deferred` | Any school/institution | 2210 |
| `tv_subscription` | `deferred` | DStv, GOtv, StarTimes, Azam TV | Float (no payable) |
| `airtime_data` | `immediate` | MTN, Airtel, Lycamobile, Uganda Telecom | Float (no payable) |
| `other` | configurable | Future providers | Configurable |

**`commission_model = 'immediate'`**: commission is recognised as income at transaction posting time. No commission receivable is created. No settlement step.

**`commission_model = 'deferred'`**: commission is accrued to `1310 Agency Commission Receivable` at posting time. A separate settlement step clears the receivable when the provider remits.

### 4.2 Float Model

| `float_model` | Description | Uses Float Account | Uses Payable Account |
|---------------|-------------|-------------------|---------------------|
| `provider_float` | Agent holds electronic float pre-funded by provider (MoMo, utility, TV, airtime) | Yes | No |
| `cash_payable` | Agent collects cash on behalf of provider; remits periodically | No | Yes |

School fees and bank agency use `cash_payable`. All others use `provider_float`.

### 4.3 Income Account Mapping

Stored on `agency_transaction_types.income_account_id` (FK to `ledger_accounts`).

| Category | Income Account |
|----------|---------------|
| `mobile_money` | 4510 |
| `agency_banking` | 4520 |
| `utility` | 4530 |
| `school_fees` | 4540 |
| `tv_subscription` | 4550 |
| `airtime_data` | 4560 |
| `other` | 4590 |

---

## 5. Data Model

### 5.1 Schema Changes to Existing Tables

```sql
-- Add agency_float to cash_kind check
ALTER TABLE public.ledger_accounts
  DROP CONSTRAINT ledger_accounts_cash_kind_check,
  ADD CONSTRAINT ledger_accounts_cash_kind_check
    CHECK (cash_kind IN ('cash_at_hand','mtn_mobile_money','airtel_money','bank','agency_float'));

-- Add agency source_types
ALTER TABLE public.journal_entries
  DROP CONSTRAINT journal_entries_source_type_check,
  ADD CONSTRAINT journal_entries_source_type_check
    CHECK (source_type IN (
      -- existing 21 values unchanged --
      'opening_balance','loan_disbursement','loan_repayment','payment_reversal',
      'penalty_charge','transfer','transfer_reversal','expense','expense_reversal',
      'other_income','other_income_reversal','reconciliation_adjustment','adjustment',
      'membership_fee','membership_fee_reversal',
      'savings_deposit','savings_deposit_reversal',
      'savings_withdrawal','savings_withdrawal_reversal',
      'benefit_payment','benefit_payment_reversal',
      -- 5 new values --
      'agency_transaction','agency_transaction_reversal',
      'agency_commission_settlement',
      'agency_payable_settlement','agency_payable_settlement_reversal'
    ));

-- Add agency settings columns
ALTER TABLE public.finance_settings
  ADD COLUMN allow_negative_agency_float boolean NOT NULL DEFAULT false,
  ADD COLUMN low_balance_agency_float bigint NOT NULL DEFAULT 200000;
```

### 5.2 `agency_service_providers`

```sql
CREATE TABLE public.agency_service_providers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE,          -- e.g. 'MTN_MOMO', 'UEDCL'
  name              text NOT NULL,
  category          text NOT NULL CHECK (category IN (
                      'mobile_money','agency_banking','utility',
                      'school_fees','tv_subscription','airtime_data','other')),
  float_model       text NOT NULL CHECK (float_model IN ('provider_float','cash_payable')),
  payable_account_id uuid REFERENCES public.ledger_accounts(id),  -- required if float_model = 'cash_payable'
  income_account_id uuid NOT NULL REFERENCES public.ledger_accounts(id),
  commission_model  text NOT NULL CHECK (commission_model IN ('deferred','immediate')),
  commission_rate   numeric(7,4),                  -- percentage, nullable (fixed amounts supported)
  commission_fixed  bigint,                        -- fixed per-transaction commission in UGX (nullable)
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payable_account_required_for_cash_payable
    CHECK (float_model != 'cash_payable' OR payable_account_id IS NOT NULL)
);
```

### 5.3 `agency_transaction_types`

```sql
CREATE TABLE public.agency_transaction_types (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id       uuid NOT NULL REFERENCES public.agency_service_providers(id),
  name              text NOT NULL,                 -- e.g. 'Deposit', 'Withdrawal', 'Bill Payment'
  direction         text NOT NULL CHECK (direction IN ('deposit','withdrawal','payment','transfer')),
  requires_meter_number boolean NOT NULL DEFAULT false,
  requires_account_number boolean NOT NULL DEFAULT false,
  max_single_transaction bigint,                   -- NULL = no limit
  requires_approval_above bigint,                  -- NULL = no approval threshold
  is_active         boolean NOT NULL DEFAULT true
);
```

### 5.4 `agency_provider_float_accounts`

Multiple tills per provider per branch supported via `till_name`.

```sql
CREATE TABLE public.agency_provider_float_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id       uuid NOT NULL REFERENCES public.agency_service_providers(id),
  branch_id         uuid NOT NULL REFERENCES public.branches(id),
  ledger_account_id uuid NOT NULL REFERENCES public.ledger_accounts(id),  -- must have cash_kind='agency_float'
  till_name         text NOT NULL DEFAULT 'main',  -- distinguishes multiple tills
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, branch_id, till_name)
);
```

### 5.5 `agency_transactions`

```sql
CREATE TABLE public.agency_transactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id           uuid NOT NULL REFERENCES public.branches(id),
  provider_id         uuid NOT NULL REFERENCES public.agency_service_providers(id),
  transaction_type_id uuid NOT NULL REFERENCES public.agency_transaction_types(id),
  -- exactly one of float_account_id or payable_account_id must be set
  float_account_id    uuid REFERENCES public.agency_provider_float_accounts(id),
  payable_account_id  uuid REFERENCES public.ledger_accounts(id),

  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','awaiting_verification','posted','reversed','cancelled')),
  principal_amount    bigint NOT NULL CHECK (principal_amount > 0),
  commission_amount   bigint NOT NULL DEFAULT 0 CHECK (commission_amount >= 0),
  customer_fee        bigint NOT NULL DEFAULT 0 CHECK (customer_fee >= 0),
  provider_reference  text,         -- external transaction ID from provider (e.g. MTN ref)
  customer_identifier text,         -- phone, meter number, account number, student number
  customer_name       text,
  description         text,
  transaction_date    date NOT NULL DEFAULT current_date,
  posted_at           timestamptz,
  reversed_at         timestamptz,
  reversal_id         uuid REFERENCES public.agency_transactions(id),  -- points to original when this IS a reversal
  original_id         uuid REFERENCES public.agency_transactions(id),  -- set on reversal record

  submitted_by        uuid NOT NULL REFERENCES public.profiles(id),
  verified_by         uuid REFERENCES public.profiles(id),
  reversed_by         uuid REFERENCES public.profiles(id),
  reversal_reason     text,

  journal_entry_id    uuid REFERENCES public.journal_entries(id),
  reversal_entry_id   uuid REFERENCES public.journal_entries(id),

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT exactly_one_settlement_account
    CHECK (
      (float_account_id IS NOT NULL AND payable_account_id IS NULL) OR
      (float_account_id IS NULL AND payable_account_id IS NOT NULL)
    ),
  CONSTRAINT verifier_not_submitter
    CHECK (verified_by IS NULL OR verified_by != submitted_by),
  CONSTRAINT reversal_not_own_original
    CHECK (original_id IS NULL OR original_id != id)
);

-- Prevent duplicate external references from being reused, including after reversal.
-- Only 'draft' and 'cancelled' states release the reference.
CREATE UNIQUE INDEX agency_transactions_provider_reference_unique
  ON public.agency_transactions (provider_id, provider_reference)
  WHERE provider_reference IS NOT NULL
    AND status NOT IN ('draft', 'cancelled');
```

### 5.6 `agency_commission_settlements`

```sql
CREATE TABLE public.agency_commission_settlements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id         uuid NOT NULL REFERENCES public.agency_service_providers(id),
  branch_id           uuid NOT NULL REFERENCES public.branches(id),
  settlement_date     date NOT NULL,
  settlement_amount   bigint NOT NULL CHECK (settlement_amount > 0),
  settlement_account_id uuid NOT NULL REFERENCES public.ledger_accounts(id), -- float or bank account receiving funds
  provider_statement_ref text,        -- provider batch reference
  journal_entry_id    uuid REFERENCES public.journal_entries(id),
  created_by          uuid NOT NULL REFERENCES public.profiles(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
```

### 5.7 `agency_payable_settlements`

```sql
CREATE TABLE public.agency_payable_settlements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id           uuid NOT NULL REFERENCES public.agency_service_providers(id),
  branch_id             uuid NOT NULL REFERENCES public.branches(id),
  payable_account_id    uuid NOT NULL REFERENCES public.ledger_accounts(id),  -- 2210 or 2220
  cash_account_id       uuid NOT NULL REFERENCES public.ledger_accounts(id),  -- cash_kind IS NOT NULL
  settlement_date       date NOT NULL,
  settlement_amount     bigint NOT NULL CHECK (settlement_amount > 0),
  provider_receipt_ref  text,
  journal_entry_id      uuid REFERENCES public.journal_entries(id),
  status                text NOT NULL DEFAULT 'posted'
                          CHECK (status IN ('posted','reversed')),
  reversed_at           timestamptz,
  reversed_by           uuid REFERENCES public.profiles(id),
  reversal_entry_id     uuid REFERENCES public.journal_entries(id),
  created_by            uuid NOT NULL REFERENCES public.profiles(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
```

### 5.8 `agency_float_reconciliations`

Electronic float: system closing balance vs. provider statement balance.

```sql
CREATE TABLE public.agency_float_reconciliations (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  float_account_id          uuid NOT NULL REFERENCES public.agency_provider_float_accounts(id),
  reconciliation_date       date NOT NULL,
  system_closing_balance    bigint NOT NULL,     -- from ledger at end of day
  provider_statement_balance bigint NOT NULL,    -- from provider's own statement
  variance                  bigint NOT NULL GENERATED ALWAYS AS
                              (system_closing_balance - provider_statement_balance) STORED,
  variance_written_off      bigint NOT NULL DEFAULT 0,
  variance_journal_entry_id uuid REFERENCES public.journal_entries(id),
  notes                     text,
  status                    text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reconciled')),
  reconciled_by             uuid REFERENCES public.profiles(id),
  reconciled_at             timestamptz,
  created_by                uuid NOT NULL REFERENCES public.profiles(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (float_account_id, reconciliation_date)
);
```

### 5.9 `agency_cash_reconciliations`

Physical cash count vs. shared `1010 Cash at Hand` ledger balance.

```sql
CREATE TABLE public.agency_cash_reconciliations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id               uuid NOT NULL REFERENCES public.branches(id),
  cash_account_id         uuid NOT NULL REFERENCES public.ledger_accounts(id),  -- 1010-BR...
  reconciliation_date     date NOT NULL,
  system_closing_balance  bigint NOT NULL,
  physical_count          bigint NOT NULL,
  variance                bigint NOT NULL GENERATED ALWAYS AS
                            (physical_count - system_closing_balance) STORED,
  variance_journal_entry_id uuid REFERENCES public.journal_entries(id),
  notes                   text,
  status                  text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reconciled')),
  reconciled_by           uuid REFERENCES public.profiles(id),
  reconciled_at           timestamptz,
  created_by              uuid NOT NULL REFERENCES public.profiles(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, cash_account_id, reconciliation_date)
);
```

### 5.10 `agency_transaction_audit_log`

```sql
CREATE TABLE public.agency_transaction_audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  uuid NOT NULL REFERENCES public.agency_transactions(id),
  action          text NOT NULL,  -- 'submit','verify','post','reverse','reference_corrected'
  actor_id        uuid NOT NULL REFERENCES public.profiles(id),
  old_value       jsonb,
  new_value       jsonb,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

---

## 6. Journal Matrix

All amounts in UGX. Amounts are illustrative; every example is arithmetically verified.
**Assets increase on debit. Liabilities and income increase on credit.**

### 6.1 Mobile Money — Deposit (customer deposits cash, agent sends from float)

The customer hands cash to the agent and funds their mobile wallet.
- Agent receives physical cash → Cash at Hand increases (DR)
- Agent uses float to fund customer's wallet → Float decreases (CR)

| # | Account | Code | DR | CR |
|---|---------|------|----|----|
| 1 | Cash at Hand | 1010-BR2601 | 100,000 | |
| 2 | MTN Float — Head Office | 1320.MTN.BR2601 | | 100,000 |
| **Total** | | | **100,000** | **100,000** ✓ |

*Insufficient-funds check (correction C3/C4): before posting, verify `1320.MTN.BR2601` balance ≥ 100,000 using `assert_agency_float_available()`.*

### 6.2 Mobile Money — Withdrawal (customer withdraws cash, agent receives float)

The customer's wallet is debited; the agent pays out physical cash.
- Agent's float is credited by the provider → Float increases (DR)
- Agent pays cash to customer → Cash at Hand decreases (CR)

| # | Account | Code | DR | CR |
|---|---------|------|----|----|
| 1 | MTN Float — Head Office | 1320.MTN.BR2601 | 100,000 | |
| 2 | Cash at Hand | 1010-BR2601 | | 100,000 |
| **Total** | | | **100,000** | **100,000** ✓ |

*Insufficient-funds check: before posting, verify `1010-BR2601` balance ≥ 100,000 using `assert_cash_available()`.*

### 6.3 Mobile Money Commission Accrual (deferred model, at transaction time)

Commission of 1,500 on either deposit or withdrawal is accrued when the transaction is posted.

| # | Account | Code | DR | CR |
|---|---------|------|----|----|
| 1 | Agency Commission Receivable | 1310 | 1,500 | |
| 2 | Mobile Money Commission | 4510 | | 1,500 |
| **Total** | | | **1,500** | **1,500** ✓ |

*This journal is posted as a separate entry in the same database transaction as §6.1/6.2.*

### 6.4 Airtime / Data Sale (immediate commission model)

The agent purchases airtime at wholesale and sells at retail. The spread is immediate income.
Example: 10,000 airtime sold; cost 9,700; commission/spread = 300.

| # | Account | Code | DR | CR |
|---|---------|------|----|----|
| 1 | Cash at Hand | 1010-BR2601 | 10,000 | |
| 2 | Airtel Float — Head Office | 1320.AIRTEL.BR2601 | | 9,700 |
| 3 | Airtime & Data Commission | 4560 | | 300 |
| **Total** | | | **10,000** | **10,000** ✓ |

*No commission receivable; no settlement step for `commission_model = 'immediate'`.*

### 6.5 UEDCL Yaka / Utility Payment (cash payable model with deferred commission)

Customer pays 50,000 for Yaka prepaid tokens. Agent commission = 500.

**Step 1 — Transaction posting:**

| # | Account | Code | DR | CR |
|---|---------|------|----|----|
| 1 | Cash at Hand | 1010-BR2601 | 50,000 | |
| 2 | UEDCL Float — Head Office | 1320.UEDCL.BR2601 | | 50,000 |
| **Total** | | | **50,000** | **50,000** ✓ |

**Step 2 — Commission accrual (same transaction):**

| # | Account | Code | DR | CR |
|---|---------|------|----|----|
| 1 | Agency Commission Receivable | 1310 | 500 | |
| 2 | Utility Commission | 4530 | | 500 |
| **Total** | | | **500** | **500** ✓ |

*Float is used for UEDCL because the agent buys Yaka tokens from their UEDCL float. If UEDCL is configured as `cash_payable`, replace §6.5-Step1 with §6.7-pattern.*

### 6.6 School Fees Collection (cash payable model)

Customer pays 200,000 school fees for a named institution. The agent holds cash on the school's behalf.

| # | Account | Code | DR | CR |
|---|---------|------|----|----|
| 1 | Cash at Hand | 1010-BR2601 | 200,000 | |
| 2 | School Fees Payable | 2210 | | 200,000 |
| **Total** | | | **200,000** | **200,000** ✓ |

No commission until settlement or if accrued separately.

### 6.7 TV Subscription (DStv) — Float Model

Customer pays 45,000 DStv monthly subscription. Agent commission = 1,350 (3%).

| # | Account | Code | DR | CR |
|---|---------|------|----|----|
| 1 | Cash at Hand | 1010-BR2601 | 45,000 | |
| 2 | DStv Float | 1320.DSTV.BR2601 | | 45,000 |
| **Total** | | | **45,000** | **45,000** ✓ |

Commission accrual (separate entry, same transaction):

| # | Account | Code | DR | CR |
|---|---------|------|----|----|
| 1 | Agency Commission Receivable | 1310 | 1,350 | |
| 2 | TV Subscription Commission | 4550 | | 1,350 |
| **Total** | | | **1,350** | **1,350** ✓ |

### 6.8 Commission Settlement (deferred model — provider remits)

MTN remits 25,000 commission batch to agent's MTN float account.

| # | Account | Code | DR | CR |
|---|---------|------|----|----|
| 1 | MTN Float — Head Office | 1320.MTN.BR2601 | 25,000 | |
| 2 | Agency Commission Receivable | 1310 | | 25,000 |
| **Total** | | | **25,000** | **25,000** ✓ |

*Partial settlement: if only 10,000 of a 25,000 receivable is settled, post 10,000 and leave 15,000 in 1310. The function must verify settlement amount ≤ outstanding receivable balance for the provider.*

### 6.9 Payable Settlement — School Fees (agent remits to school)

Agent hands over 200,000 in cash collections to the school, clearing the payable.

| # | Account | Code | DR | CR |
|---|---------|------|----|----|
| 1 | School Fees Payable | 2210 | 200,000 | |
| 2 | Cash at Hand | 1010-BR2601 | | 200,000 |
| **Total** | | | **200,000** | **200,000** ✓ |

*This uses `post_agency_payable_settlement()`, NOT `record_transfer()`. The payable account (2210) has `cash_kind = NULL` and would fail `assert_cash_account()`.*

### 6.10 Float Replenishment (agent tops up float from bank account)

Agent transfers 500,000 from Cash at Bank to MTN float.

| # | Account | Code | DR | CR |
|---|---------|------|----|----|
| 1 | MTN Float — Head Office | 1320.MTN.BR2601 | 500,000 | |
| 2 | Cash at Bank | 1040-BR2601 | | 500,000 |
| **Total** | | | **500,000** | **500,000** ✓ |

*Both accounts have `cash_kind IS NOT NULL` (mtn_money=agency_float vs bank). `record_transfer()` is still NOT used here because the float account has `cash_kind = 'agency_float'`, not `'mtn_mobile_money'` or `'bank'`. Use a dedicated `post_float_replenishment()` function or extend `record_transfer()` to accept `agency_float` — decision deferred for implementation.*

### 6.11 Transaction Reversal

Reversal of the §6.1 deposit (100,000 MoMo deposit is reversed).

| # | Account | Code | DR | CR |
|---|---------|------|----|----|
| 1 | MTN Float — Head Office | 1320.MTN.BR2601 | 100,000 | |
| 2 | Cash at Hand | 1010-BR2601 | | 100,000 |
| **Total** | | | **100,000** | **100,000** ✓ |

Reversal of associated commission accrual:

| # | Account | Code | DR | CR |
|---|---------|------|----|----|
| 1 | Mobile Money Commission | 4510 | 1,500 | |
| 2 | Agency Commission Receivable | 1310 | | 1,500 |
| **Total** | | | **1,500** | **1,500** ✓ |

*source_type = `'agency_transaction_reversal'`.*

### 6.12 Float Reconciliation Variance Write-off

At day-end, system float shows 1,000 more than provider statement (unexplained surplus written off).

| # | Account | Code | DR | CR |
|---|---------|------|----|----|
| 1 | MTN Float — Head Office | 1320.MTN.BR2601 | | 1,000 |
| 2 | Agency Float Over and Short | 5960 | 1,000 | |
| **Total** | | | **1,000** | **1,000** ✓ |

*source_type = `'reconciliation_adjustment'` (existing value).*

---

## 7. State Machine

### 7.1 Transaction States

```
draft ──────────────────────────────────────────────────────► cancelled
  │
  │  submit_agency_transaction()
  ▼
awaiting_verification
  │
  │  verify_agency_transaction()  [verified_by ≠ submitted_by]
  ▼
posted ──────────────────────────────────────────────────────► reversed
```

| Transition | Function | Permission | Constraints |
|-----------|----------|------------|-------------|
| `draft → awaiting_verification` | `submit_agency_transaction()` | `agency:write` | provider_reference required if provider requires it |
| `draft → cancelled` | `cancel_agency_transaction()` | `agency:write` | only own drafts; no journal movement |
| `awaiting_verification → posted` | `verify_agency_transaction()` | `agency:verify` | verifier ≠ submitter; posts journals |
| `posted → reversed` | `reverse_agency_transaction()` | `agency:reverse` | same-day or `agency:reverse_cross_day` for prior-day; contra journals posted; commission accrual reversed if not yet settled |

### 7.2 Reference Correction (not a state transition)

`update_agency_transaction_reference()` is callable only in `posted` status.
It changes `provider_reference` only — no journal entries. Requires `agency:correct` permission.
An audit log entry is created with `action = 'reference_corrected'`, old and new reference, and reason.

---

## 8. Posting Functions

All functions are `SECURITY INVOKER` unless otherwise noted. All call `current_profile_id()` to establish identity. All call `require_permission()` (or its equivalent) before any data mutation.

### 8.1 `assert_agency_float_available(p_account_id uuid, p_amount bigint)`

```
purpose:   Abort if the agency float account balance < p_amount
           AND allow_negative_agency_float is false in finance_settings.
           Reads ONLY allow_negative_agency_float — never allow_negative_cash.
reads:     finance_settings.allow_negative_agency_float
           ledger_account_balances view (net balance of p_account_id)
raises:    'P0001' / 'insufficient_agency_float'
```

### 8.2 `post_agency_transaction(p_transaction_id uuid) → void`

Called by `verify_agency_transaction()` after state validation.

```
1. Load transaction record; assert status = 'awaiting_verification'
2. Load provider and transaction_type; assert both active
3. Load float_account_id or payable_account_id

IF float_model = 'provider_float':
  IF direction = 'deposit':
    - assert_agency_float_available(float_ledger_account, principal_amount)
    - Journal: DR Cash at Hand, CR Float  (§6.1)
  IF direction = 'withdrawal':
    - assert_cash_available(cash_account_id, principal_amount)
    - Journal: DR Float, CR Cash at Hand  (§6.2)
  IF direction = 'payment' (utility, TV, airtime):
    - assert_agency_float_available(float_ledger_account, principal_amount)
    - Journal: DR Cash at Hand, CR Float  (§6.5-Step1)

IF float_model = 'cash_payable':
  - Journal: DR Cash at Hand, CR Payable account  (§6.6)

IF commission_model = 'deferred' AND commission_amount > 0:
  - Commission journal: DR 1310, CR income_account  (§6.3)

IF commission_model = 'immediate' AND commission_amount > 0:
  - Transaction journal: include income line directly  (§6.4)

4. Set status = 'posted', posted_at = now(), journal_entry_id
5. Audit log entry
```

### 8.3 `reverse_agency_transaction(p_transaction_id uuid, p_reason text) → void`

```
1. Load transaction; assert status = 'posted'
2. Same-day check: if transaction_date < current_date, require agency:reverse_cross_day
3. Load original journals; build contra lines
4. Post contra journal (source_type = 'agency_transaction_reversal', source_id = original transaction)
5. If commission was accrued and NOT yet settled: reverse commission journal too
6. If commission was already settled: raise error — reversal blocked until commission settlement is itself reversed
7. Set status = 'reversed', reversed_at, reversed_by, reversal_entry_id
8. Audit log
```

### 8.4 `record_commission_settlement(p_provider_id, p_branch_id, p_settlement_amount, p_settlement_account_id, p_statement_ref) → uuid`

```
1. Require agency:settlements permission
2. Check commission_model = 'deferred' — raise error if 'immediate'
3. Compute outstanding receivable balance for provider (from 1310 filtered by provider_id in source transactions)
4. Reject if p_settlement_amount > outstanding_receivable_balance
5. Post journal: DR settlement_account, CR 1310  (§6.8)
6. Insert agency_commission_settlements record
7. Return settlement_id
```

### 8.5 `post_agency_payable_settlement(p_provider_id, p_branch_id, p_settlement_amount, p_cash_account_id, p_receipt_ref) → uuid`

```
1. Require agency:settlements permission
2. Load payable_account_id from agency_service_providers
3. Check cash_kind IS NOT NULL on p_cash_account_id — raise error if not a cash account
4. Compute payable balance; reject if p_settlement_amount > payable balance
5. Post journal: DR payable_account, CR cash_account  (§6.9, source_type='agency_payable_settlement')
6. Insert agency_payable_settlements record
7. Return settlement_id
```

**Note**: Does NOT call `record_transfer()`. The payable account has `cash_kind = NULL` and fails `assert_cash_account()`. This function posts directly via `post_journal()`.

### 8.6 `update_agency_transaction_reference(p_transaction_id uuid, p_new_reference text, p_reason text) → void`

```
1. Require agency:correct permission
2. Load transaction; assert status = 'posted'
3. Uniqueness check: new reference must not conflict with another non-draft/non-cancelled
   transaction for the same provider (partial index on agency_transactions)
4. Update provider_reference; set updated_at
5. Insert audit log entry: action='reference_corrected', old_value, new_value, reason
6. NO journal entries created or modified
```

---

## 9. Permission Model

New permissions added to the existing permissions system:

| Permission | Who holds it | Description |
|-----------|--------------|-------------|
| `agency:write` | secretary_treasurer, manager | Create/edit/cancel draft transactions |
| `agency:verify` | secretary_treasurer (cannot verify own), manager | Verify awaiting transactions; triggers journal posting |
| `agency:reverse` | manager | Reverse same-day posted transactions |
| `agency:reverse_cross_day` | owner_admin | Reverse prior-day transactions |
| `agency:correct` | manager | Correct provider_reference on posted transactions (no journal) |
| `agency:settlements` | manager, owner_admin | Post commission settlements and payable settlements |
| `agency:reconcile` | manager, owner_admin | Submit float and cash reconciliations |
| `agency:providers` | owner_admin | Create/edit providers and transaction types |
| `agency:reports` | All roles | View agency reports and commission summaries |

---

## 10. Views & Reports

### 10.1 `agency_float_balances`

```sql
CREATE VIEW public.agency_float_balances WITH (security_invoker = true) AS
SELECT
  apfa.id              AS float_account_id,
  p.code               AS provider_code,
  p.name               AS provider_name,
  b.name               AS branch_name,
  apfa.till_name,
  la.code              AS ledger_code,
  la.name              AS ledger_name,
  COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)::bigint AS balance
FROM public.agency_provider_float_accounts apfa
JOIN public.agency_service_providers p ON p.id = apfa.provider_id
JOIN public.branches b ON b.id = apfa.branch_id
JOIN public.ledger_accounts la ON la.id = apfa.ledger_account_id
LEFT JOIN public.journal_lines jl ON jl.account_id = la.id
GROUP BY apfa.id, p.code, p.name, b.name, apfa.till_name, la.code, la.name;
```

### 10.2 `agency_commission_report`

Provides net recognized income per provider per income account, inclusive of reversal contra entries. Reversals reduce net income naturally because reversal entries debit the income account.

```sql
CREATE VIEW public.agency_commission_report WITH (security_invoker = true) AS
SELECT
  asp.id               AS provider_id,
  asp.code             AS provider_code,
  asp.name             AS provider_name,
  asp.category,
  la.code              AS income_account_code,
  la.name              AS income_account_name,
  -- credits (original postings) minus debits (reversals) = net recognized income
  (COALESCE(SUM(jl.credit), 0) - COALESCE(SUM(jl.debit), 0))::bigint AS net_income,
  COUNT(DISTINCT t.id) FILTER (WHERE je.source_type = 'agency_transaction') AS posted_count,
  COUNT(DISTINCT t.id) FILTER (WHERE je.source_type = 'agency_transaction_reversal') AS reversed_count
FROM public.ledger_accounts la
JOIN public.journal_lines jl ON jl.account_id = la.id
JOIN public.journal_entries je ON je.id = jl.entry_id
  AND je.source_type IN ('agency_transaction','agency_transaction_reversal')
JOIN public.agency_transactions t ON je.source_id = t.id
JOIN public.agency_service_providers asp ON asp.id = t.provider_id
WHERE la.code BETWEEN '4510' AND '4590'
GROUP BY asp.id, asp.code, asp.name, asp.category, la.code, la.name;
```

### 10.3 `agency_transaction_history`

```sql
CREATE VIEW public.agency_transaction_history WITH (security_invoker = true) AS
SELECT
  t.id,
  t.transaction_date,
  asp.name             AS provider_name,
  asp.category,
  att.name             AS transaction_type,
  att.direction,
  t.status,
  t.principal_amount,
  t.commission_amount,
  t.customer_fee,
  t.customer_identifier,
  t.customer_name,
  t.provider_reference,
  t.description,
  b.name               AS branch_name,
  apfa.till_name,
  sub.full_name        AS submitted_by_name,
  ver.full_name        AS verified_by_name,
  t.posted_at,
  t.reversed_at
FROM public.agency_transactions t
JOIN public.agency_service_providers asp ON asp.id = t.provider_id
JOIN public.agency_transaction_types att ON att.id = t.transaction_type_id
JOIN public.branches b ON b.id = t.branch_id
LEFT JOIN public.agency_provider_float_accounts apfa ON apfa.id = t.float_account_id
JOIN public.profiles sub ON sub.id = t.submitted_by
LEFT JOIN public.profiles ver ON ver.id = t.verified_by;
```

---

## 11. Test Suite

Tests are database-level, using `pgTAP` or the project's existing `pg_test` framework, against the dev branch only. No production changes.

### 11.1 Setup & Teardown (shared fixture)

```
SETUP:
  - Create test branch BR9999 with Cash at Hand (1010-BR9999), Cash at Bank (1040-BR9999)
  - Create test providers: MTN (mobile_money, deferred), UEDCL (utility, deferred),
    DStv (tv_subscription, deferred), Lycamobile (airtime_data, immediate)
  - Create float accounts: MTN.BR9999 (1320.MTN.BR9999, initial balance 500,000)
    Lycamobile.BR9999 (1320.LYCA.BR9999, initial balance 200,000)
    — funded via opening_balance journal
  - Set up profiles: p_owner (owner_admin), p_manager (manager),
    p_st1 (secretary_treasurer, submitter), p_st2 (secretary_treasurer, verifier)
  - Snapshot ledger balances at start of each test

TEARDOWN:
  - Rollback transaction (tests run inside a savepoint)
```

### 11.2 Functional Tests

**T-01: Draft transaction created, status = draft, no journal**
- Submit draft MTN deposit, 50,000; check status = 'draft'; verify journal_entry_id IS NULL

**T-02: Submit moves to awaiting_verification**
- `submit_agency_transaction(t_id)` as p_st1; assert status = 'awaiting_verification'

**T-03: Submitter cannot verify own transaction**
- p_st1 attempts `verify_agency_transaction(t_id)`; expect error (verifier ≠ submitter constraint)

**T-04: Verifier cannot be same as submitter at DB level**
- Attempt INSERT/UPDATE setting verified_by = submitted_by; expect CHECK constraint violation

**T-05: Verify posts correct journals for deposit**
- p_st2 verifies the MTN deposit; load journal lines
- Assert: DR 1010-BR9999 = 50,000; CR 1320.MTN.BR9999 = 50,000; balanced

**T-06: Commission accrual journal posted for deferred model**
- After T-05 verifies; check for commission journal
- Assert: DR 1310 = commission_amount; CR 4510 = commission_amount; balanced

**T-07: Immediate commission recognized at posting (no receivable)**
- Create Lycamobile airtime sale; verify
- Assert: 1310 (Agency Commission Receivable) is unchanged; 4560 credited with spread

**T-08: Withdrawal journals are opposite of deposit**
- Create MTN withdrawal 30,000; verify
- Assert: DR 1320.MTN.BR9999 = 30,000; CR 1010-BR9999 = 30,000; balanced

**T-09: School fees payable journal**
- Create school fees payment 100,000; verify
- Assert: DR 1010-BR9999 = 100,000; CR 2210 = 100,000

**T-10: Cash at Hand and float are independent within a transaction**
- Cash at Hand balance before = X. MTN float balance before = Y.
- Post deposit of 50,000.
- After: Cash at Hand = X + 50,000; Float = Y − 50,000; Loans Receivable unchanged; Interest Income unchanged.

**T-11: Payable settlement posts correct journal**
- `post_agency_payable_settlement()` for 100,000 school fees
- Assert: DR 2210 = 100,000; CR 1010-BR9999 = 100,000; source_type = 'agency_payable_settlement'

**T-12: Commission settlement clears receivable**
- Post 3 × deferred transactions, total commission = 4,500
- Call `record_commission_settlement(provider_id, branch_id, 4,500, float_account_id, 'BATCH-001')`
- Assert: 1310 net change = −4,500; float_account DR = 4,500

**T-13a: Deposit rejected when float is insufficient (correction C3)**
- Set MTN float balance = 10,000
- Attempt deposit of 50,000 (float = DR Cash at Hand, CR Float → float would go negative)
- Assert: function raises 'insufficient_agency_float'

**T-13b: Withdrawal rejected when Cash at Hand is insufficient (correction C3)**
- Set Cash at Hand balance = 10,000
- Attempt withdrawal of 50,000 (withdrawal = DR Float, CR Cash → cash would go negative)
- Assert: function raises error (insufficient cash, governed by `assert_cash_available()` + `allow_negative_cash = false`)

**T-14: Duplicate provider_reference rejected**
- Post transaction T-A with provider_reference = 'MTN-XYZ-001' (status → posted)
- Attempt new transaction with same provider_reference and same provider
- Assert: unique constraint violation

**T-15: Reversed transaction's reference cannot be reused**
- Post and reverse transaction T-A with provider_reference = 'MTN-XYZ-001' (status → reversed)
- Attempt new transaction with same provider_reference
- Assert: unique constraint violation (index excludes only 'draft' and 'cancelled')

**T-16: Same-day reversal posts contra journals**
- Verify deposit T-A (100,000); then reverse it same day
- Assert: DR 1320.MTN.BR9999 = 100,000; CR 1010-BR9999 = 100,000 (contra of original)
- Assert: commission accrual also reversed (DR 4510, CR 1310)

**T-17: Cross-day reversal requires agency:reverse_cross_day**
- Advance `business_date()` to tomorrow; attempt reversal as p_manager (no cross_day permission)
- Assert: permission error raised

**T-18: Reference correction does not create journal**
- `update_agency_transaction_reference(t_id, 'MTN-CORRECTED', 'Typo in original')`
- Assert: no new journal_entries rows; provider_reference updated; audit_log shows 'reference_corrected'

**T-19: Reversal blocked if commission already settled**
- Post transaction and settle its commission
- Attempt reversal of original transaction
- Assert: error raised ('commission_already_settled')

**T-20: Commission settlement rejected for immediate-model provider**
- Attempt `record_commission_settlement()` against Lycamobile (commission_model = 'immediate')
- Assert: error raised

**T-21: Partial commission settlement leaves correct residual**
- Accrue 12,500 in commission across multiple transactions
- Settle 5,000 first batch
- Assert: 1310 balance = 7,500; 5,000 in settlement account

**T-22: `allow_negative_agency_float` governs only float accounts**
- Set `allow_negative_agency_float = true`, `allow_negative_cash = false`
- Deposit with float = 0: should SUCCEED (float can go negative)
- Withdrawal with cash = 0: should FAIL (`allow_negative_cash = false`)
- Confirm the two policies are fully independent

**T-23: Multiple tills for same provider and branch**
- Create MTN.BR9999.T1 and MTN.BR9999.T2 (two float accounts, same provider+branch)
- Post deposit to T1; post deposit to T2
- Assert: each till's balance updated independently; no constraint violation

### 11.3 Separation-of-Duties Tests

**T-SD01: Only owner_admin can reverse cross-day** (see T-17)

**T-SD02: Only agency:settlements can settle commission**
- p_st1 (no agency:settlements) attempts commission settlement; expect permission error

**T-SD03: Only agency:providers can create providers**
- p_manager (no agency:providers) attempts INSERT into agency_service_providers; expect RLS denial

### 11.4 Ledger Isolation Tests (correction C10)

**T-S06 (corrected): Agency transaction does not touch lending-specific accounts**
- Record snapshots: 1200 (Loans Receivable), 4100 (Interest Income), 4200 (Penalty Income) balances
- Post an agency deposit of 50,000
- Assert: 1200, 4100, 4200 balances are **unchanged**
- *Cash at Hand (1010) and agency float (1320.MTN) are expected to change — this is correct*

**T-S07: Lending transaction does not touch agency accounts**
- Record snapshots: 1310 (Commission Receivable), 4510–4590 (Agency Income accounts) balances
- Post a loan disbursement via `disburse_loan()`
- Assert: 1310, 4510–4590 balances are **unchanged**

### 11.5 Reconciliation Tests

**T-R01: Float reconciliation creates correct variance**
- Set system float = 500,000; provider statement = 498,000
- Insert agency_float_reconciliation
- Assert: variance = 2,000 (500,000 − 498,000)

**T-R02: Float variance write-off posts to 5960**
- Confirm and write off the 2,000 variance
- Assert: journal DR 5960 = 2,000, CR 1320.MTN.BR9999 = 2,000; source_type = 'reconciliation_adjustment'

**T-R03: Cash reconciliation captures shortage**
- System Cash at Hand = 200,000; physical count = 195,000
- Insert agency_cash_reconciliation; variance = −5,000
- Assert: shortage may be written off to 5950 (Cash Over and Short, existing account)

---

## 12. Migration Checklist

This is NOT a migration file. It is a checklist of all schema changes required. Implementation order matters due to foreign key dependencies.

**Step 1 — Extend existing constraints**
- [ ] Alter `ledger_accounts.cash_kind` check to add `'agency_float'`
- [ ] Alter `journal_entries.source_type` check to add 5 new values
- [ ] Alter `finance_settings` to add `allow_negative_agency_float` and `low_balance_agency_float`

**Step 2 — New lookup / chart accounts**
- [ ] Insert `1300 Agency Services Assets` heading
- [ ] Insert `1310 Agency Commission Receivable`
- [ ] Insert `1320 Agency Float Accounts` heading
- [ ] Insert `2200 Agency Service Payables` heading
- [ ] Insert `2210 School Fees Payable`
- [ ] Insert `2220 Bank Agency Payable`
- [ ] Insert `2290 Other Agency Payables`
- [ ] Insert `4500 Agency Services Income` heading
- [ ] Insert `4510–4590` income accounts (7 accounts)
- [ ] Insert `5960 Agency Float Over and Short`

**Step 3 — New tables (in dependency order)**
1. `agency_service_providers`
2. `agency_transaction_types`
3. `agency_provider_float_accounts`
4. `agency_transactions`
5. `agency_commission_settlements`
6. `agency_payable_settlements`
7. `agency_float_reconciliations`
8. `agency_cash_reconciliations`
9. `agency_transaction_audit_log`

**Step 4 — New functions**
- [ ] `assert_agency_float_available()`
- [ ] `post_agency_transaction()`
- [ ] `submit_agency_transaction()`
- [ ] `verify_agency_transaction()`
- [ ] `cancel_agency_transaction()`
- [ ] `reverse_agency_transaction()`
- [ ] `record_commission_settlement()`
- [ ] `post_agency_payable_settlement()`
- [ ] `update_agency_transaction_reference()`
- [ ] `post_float_replenishment()` (or extend `record_transfer()`)

**Step 5 — New views**
- [ ] `agency_float_balances`
- [ ] `agency_commission_report`
- [ ] `agency_transaction_history`

**Step 6 — RLS policies**
- [ ] Row-level security on all new tables: `current_profile_id()` as anchor predicate
- [ ] Permissions in `permissions_registry` for all 9 new permission keys

**Step 7 — Seed data**
- [ ] Insert 8 provider records: MTN MoMo, Airtel Money, UEDCL, NWSC, Stanbic, DStv, GOtv, Lycamobile
- [ ] Insert float accounts for each active provider + branch
- [ ] Update `finance_settings` defaults for agency float threshold

---

## 13. GO / NO-GO Recommendation

### Verdict: **CONDITIONAL GO** — Subject to approval of this specification

The architecture as designed is **ready for implementation approval**. The outstanding conditions are:

**Conditions that must be met before writing the first migration:**

| # | Condition | Owner |
|---|-----------|-------|
| A | This specification is explicitly approved by the product owner | Product owner |
| B | Account codes 2210, 2220, 2290, 4500–4590, 5960 are confirmed acceptable for the chart | Product owner |
| C | The `commission_model` defaults for each provider are confirmed (which providers use 'immediate' vs. 'deferred') | Product owner |
| D | Security PR #18 release decision is made (independent from this module; no blocker unless deployment is blocked) | Product owner |

**Architecture is sound because:**
- All 13 user corrections are applied
- Every journal in §6 is arithmetically balanced (verified manually)
- Account codes were confirmed free against live production data
- The double-entry ledger is reused — no new ledger engine
- The existing `post_journal()` helper is used for all postings
- RLS anchor (`current_profile_id()`) is respected throughout
- Lending and agency income are separately reportable
- Commission receivable is properly deferred vs. immediate
- Multiple tills are supported per provider per branch
- The `record_transfer()` limitation is respected: `post_agency_payable_settlement()` is a separate, dedicated function
- `allow_negative_agency_float` is independent of `allow_negative_cash` — no accidental bypass possible
- Reversed transactions retain their `provider_reference` in the uniqueness index (status not in `'draft','cancelled'`)

**Risks to manage during implementation:**
1. The `source_type` constraint change is a `DROP CONSTRAINT` + `ADD CONSTRAINT` on a live table — run in a migration with minimal lock time; not applicable until authorised.
2. The `cash_kind` constraint change follows the same pattern — straightforward in a dev branch.
3. Float account creation per provider per branch requires an outreach to identify which providers are active at each branch before seeding.

**Security PR #18 relationship:** This module does not depend on PR #18. Both can be implemented independently. PR #18 (forced-password change boundary) should be resolved on its own timeline through the gate process already documented in `docs/POLYTOS-SECURITY-RELEASE-GATES.md`.
