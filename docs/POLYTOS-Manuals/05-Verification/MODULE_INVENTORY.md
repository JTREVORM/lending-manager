# POLYTOS — Module Inventory

Every entry in the application's navigation rail, the route behind it, the roles that
can reach it, whether it is implemented, whether this documentation project
photographed it at each width, and which manual chapter covers it.

Generated from `components/layout/nav-items.ts`, `lib/auth/routing.ts`,
`lib/permissions/permissions.ts` and the screenshot manifest produced by
`04-Demo-Data/capture-manual-screens.mjs`.

**14 modules · 126 navigation entries · 68 distinct routes**

`C` Client · `S` Secretary / Treasurer · `M` Manager · `O` Owner / Administrator

## Clients

| Submodule / entry | Route | Capability | Roles | Status | Desktop | Mobile | Chapter |
| --- | --- | --- | :---: | --- | :---: | :---: | --- |
| Client Register | `/clients` | `clients:view` | SMO | Implemented | yes | yes | User 9 |
| New Client | `/clients/new` | `clients:view` | MO | Implemented | yes | yes | User 9 |
| Active Clients | `/clients?status=active` | `clients:view` | SMO | Implemented | yes | yes | User 9 |
| Inactive Clients | `/clients?status=inactive` | `clients:view` | SMO | Implemented | yes | yes | User 9 |
| Suspended Clients | `/clients?status=suspended` | `clients:view` | SMO | Implemented | yes | yes | User 9 |
| Blacklisted Clients | `/clients?status=blacklisted` | `clients:view` | SMO | Implemented | yes | yes | User 9 |
| Client History | `/audit?entity=client` | `audit:view` | O | Implemented | yes | yes | User 9 |

## Membership

| Submodule / entry | Route | Capability | Roles | Status | Desktop | Mobile | Chapter |
| --- | --- | --- | :---: | --- | :---: | :---: | --- |
| Membership Register | `/membership` | `membership:view` | SMO | Implemented | yes | yes | User 10 |
| Enrol a Member | `/membership/enrol` | `membership:view` | MO | Implemented | yes | yes | User 10 |
| Active Members | `/membership?status=active` | `membership:view` | SMO | Implemented | yes | yes | User 10 |
| Pending Applications | `/membership?status=pending` | `membership:view` | SMO | Implemented | yes | yes | User 10 |
| Suspended Members | `/membership?status=suspended` | `membership:view` | SMO | Implemented | yes | yes | User 10 |
| Former Members | `/membership?status=withdrawn` | `membership:view` | SMO | Implemented | yes | yes | User 10 |
| Membership Policy | `/membership/policies` | `membership:view` | SMO | Implemented | yes | yes | User 10 |
| Membership History | `/audit?entity=membership` | `audit:view` | O | Implemented | yes | yes | User 10 |

## Member Savings

| Submodule / entry | Route | Capability | Roles | Status | Desktop | Mobile | Chapter |
| --- | --- | --- | :---: | --- | :---: | :---: | --- |
| Savings Register | `/savings` | `savings:view` | SMO | Implemented | yes | yes | User 11 |
| Active Accounts | `/savings?status=active` | `savings:view` | SMO | Implemented | yes | yes | User 11 |
| Dormant Accounts | `/savings?status=dormant` | `savings:view` | SMO | Implemented | yes | yes | User 11 |
| Withdrawal Requests | `/savings/withdrawals` | `savings:approve_withdrawal` | MO | Implemented | yes | yes | User 11 |
| Savings History | `/audit?entity=savings` | `audit:view` | O | Implemented | yes | yes | User 11 |

## Member Lending

| Submodule / entry | Route | Capability | Roles | Status | Desktop | Mobile | Chapter |
| --- | --- | --- | :---: | --- | :---: | :---: | --- |
| Who Can Borrow | `/member-loans?tab=members` | `member_loans:view_eligibility` | SMO | Implemented | yes | yes | User 12 |
| Member Loans | `/member-loans?tab=loans` | `member_loans:view_eligibility` | SMO | Implemented | yes | yes | User 12 |
| Qualified Members | `/member-loans?tab=members&qualified=qualified` | `member_loans:view_eligibility` | SMO | Implemented | yes | yes | User 12 |
| New Application | `/member-loans/new` | `member_loans:create` | MO | Implemented | yes | yes | User 12 |

## Member Benefits

| Submodule / entry | Route | Capability | Roles | Status | Desktop | Mobile | Chapter |
| --- | --- | --- | :---: | --- | :---: | :---: | --- |
| Benefits Dashboard | `/benefits` | `benefits:view` | SMO | Implemented | yes | yes | User 13 |
| Claims Register | `/benefits/claims` | `benefits:view` | SMO | Implemented | yes | yes | User 13 |
| New Claim | `/benefits/claims/new` | `benefits:view` | SMO | Implemented | yes | yes | User 13 |
| Awaiting Verification | `/benefits/claims?status=submitted` | `benefits:view` | MO | Implemented | yes | yes | User 13 |
| Approval Queue | `/benefits/approvals` | `benefits:approve` | O | Implemented | yes | yes | User 13 |
| Benefit Payments | `/benefits/payments` | `benefits:pay` | MO | Implemented | yes | yes | User 13 |
| Benefits Reports | `/benefits/reports` | `benefits:view` | SMO | Implemented | yes | yes | User 13 |
| Beneficiary Register | `/beneficiaries` | `beneficiaries:view` | SMO | Implemented | yes | yes | User 13 |
| Benefits History | `/audit?entity=benefit_claim` | `audit:view` | O | Implemented | yes | yes | User 13 |

## Meetings

| Submodule / entry | Route | Capability | Roles | Status | Desktop | Mobile | Chapter |
| --- | --- | --- | :---: | --- | :---: | :---: | --- |
| Meetings Calendar | `/meetings` | `meetings:view` | SMO | Implemented | yes | yes | User 14 |
| Upcoming Meetings | `/meetings?status=upcoming` | `meetings:view` | SMO | Implemented | yes | yes | User 14 |
| Past Meetings | `/meetings?status=held` | `meetings:view` | SMO | Implemented | yes | yes | User 14 |
| Schedule Meeting | `/meetings/new` | `meetings:view` | SMO | Implemented | yes | yes | User 14 |

## Loan Management

| Submodule / entry | Route | Capability | Roles | Status | Desktop | Mobile | Chapter |
| --- | --- | --- | :---: | --- | :---: | :---: | --- |
| Loan Register | `/loans` | `loans:view` | SMO | Implemented | yes | yes | User 15 |
| New Loan Application | `/loans/new` | `loans:view` | SMO | Implemented | yes | yes | User 15 |
| Draft Applications | `/loans?stage=draft` | `loans:view` | SMO | Implemented | yes | yes | User 15 |
| Pending Approval | `/loans?stage=pending_approval` | `loans:view` | SMO | Implemented | yes | yes | User 15 |
| Approved Loans | `/loans?stage=approved` | `loans:view` | SMO | Implemented | yes | yes | User 15 |
| Awaiting Disbursement | `/loans?stage=awaiting_disbursement` | `loans:view` | SMO | Implemented | yes | yes | User 15 |
| Active Loans | `/loans?stage=active` | `loans:view` | SMO | Implemented | yes | yes | User 15 |
| Grace Period | `/loans?stage=grace_period` | `loans:view` | SMO | Implemented | yes | yes | User 15 |
| Arrears | `/loans?stage=arrears` | `loans:view` | SMO | Implemented | yes | yes | User 15 |
| Cleared Loans | `/loans?stage=cleared` | `loans:view` | SMO | Implemented | yes | yes | User 15 |
| Rejected | `/loans?stage=rejected` | `loans:view` | SMO | Implemented | yes | yes | User 15 |
| Cancelled | `/loans?stage=withdrawn` | `loans:view` | SMO | Implemented | yes | yes | User 15 |
| Loans by Product | `/loans/by-product` | `loans:view` | SMO | Implemented | yes | yes | User 15 |
| Loan History | `/audit?entity=loan` | `audit:view` | O | Implemented | yes | yes | User 15 |

## Collections

| Submodule / entry | Route | Capability | Roles | Status | Desktop | Mobile | Chapter |
| --- | --- | --- | :---: | --- | :---: | :---: | --- |
| Collect Payment | `/payments/new` | `payments:view` | SMO | Implemented | yes | yes | User 16 |
| Payment History | `/payments` | `payments:view` | SMO | Implemented | yes | yes | User 16 |
| Today's Collections | `/reports/collections?period=today` | `reports:view_operational` | SMO | Implemented | yes | yes | User 16 |
| Reversals | `/payments?status=reversed` | `payments:view` | SMO | Implemented | yes | yes | User 16 |
| Collection Summary | `/payments/summary` | `payments:view` | SMO | Implemented | yes | yes | User 16 |
| Collections by Payment Method | `/payments/summary?section=method#by-method` | `payments:view` | SMO | Implemented | yes | yes | User 16 |
| Collections by Staff | `/payments/summary?section=staff#by-staff` | `payments:view` | SMO | Implemented | yes | yes | User 16 |
| Collections by Loan Product | `/payments/summary?section=product#by-product` | `payments:view` | SMO | Implemented | yes | yes | User 16 |

## Debt & Security

| Submodule / entry | Route | Capability | Roles | Status | Desktop | Mobile | Chapter |
| --- | --- | --- | :---: | --- | :---: | :---: | --- |
| Overdue Loans | `/overdue` | `delinquency:view` | SMO | Implemented | yes | yes | User 17 |
| Aging Buckets | `/recovery` | `recovery:view` | SMO | Implemented | yes | yes | User 17 |
| Risk Monitoring | `/recovery?view=risk` | `recovery:view` | SMO | Implemented | yes | yes | User 17 |
| Follow-Ups | `/recovery?view=follow-ups` | `recovery:view` | SMO | Implemented | yes | yes | User 17 |
| Promise to Pay | `/recovery?view=promises` | `recovery:view` | SMO | Implemented | yes | yes | User 17 |
| Collateral / Security | `/recovery?view=security` | `recovery:view` | SMO | Implemented | yes | yes | User 17 |
| Guarantors | `/guarantors/register` | `guarantors:view` | SMO | Implemented | yes | yes | User 17 |
| Guarantor Directory | `/guarantors` | `guarantors:view` | SMO | Implemented | yes | yes | User 17 |
| Guarantor Exposure | `/reports/guarantors` | `reports:view_operational` | MO | Implemented | yes | yes | User 17 |
| Arrears Report | `/reports/arrears` | `reports:view_operational` | SMO | Implemented | yes | yes | User 17 |
| Penalties | `/reports/penalties` | `reports:view_operational` | MO | Implemented | yes | yes | User 17 |
| Recovery Notes | `/reports/recovery` | `reports:view_operational` | SMO | Implemented | yes | yes | User 17 |

## Finance

| Submodule / entry | Route | Capability | Roles | Status | Desktop | Mobile | Chapter |
| --- | --- | --- | :---: | --- | :---: | :---: | --- |
| Cash Position | `/finance` | `ledger:view` | SMO | Implemented | yes | yes | User 18 |
| Transfers | `/finance/transfers` | `transfers:view` | SMO | Implemented | yes | yes | User 18 |
| Expenses | `/finance/expenses` | `expenses:view` | SMO | Implemented | yes | yes | User 18 |
| Other Income | `/finance/income` | `income:view` | SMO | Implemented | yes | yes | User 18 |
| Cash Received | `/finance/receipts` | `receipts:view` | SMO | Implemented | yes | yes | User 18 |
| Bank Deposits | `/finance/deposits` | `deposits:view` | SMO | Implemented | yes | yes | User 18 |
| Reconciliation | `/finance/reconciliation` | `reconciliation:view` | SMO | Implemented | yes | yes | User 18 |
| Capital | `/finance/capital` | `capital:view` | MO | Implemented | yes | yes | User 18 |
| General Ledger | `/finance/ledger` | `ledger:view` | SMO | Implemented | yes | yes | User 18 |
| Trial Balance | `/finance/trial-balance` | `ledger:view` | SMO | Implemented | yes | yes | User 18 |

## Agency

| Submodule / entry | Route | Capability | Roles | Status | Desktop | Mobile | Chapter |
| --- | --- | --- | :---: | --- | :---: | :---: | --- |
| Agent Banking / Overview | `/agency/banking` | `agency:reports` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Agent Banking / Record transaction | `/agency/record` | `agency:write` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Agent Banking / Pending verification | `/agency/pending` | `agency:reports` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Agent Banking / Transaction history | `/agency/history` | `agency:reports` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Agent Banking / Float top-ups | `/agency/float/replenish` | `agency:settlements` | MO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Agent Banking / Account transfers | `/agency/transfers` | `agency:float_trade` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Agent Banking / Cash banking | `/agency/cash-banking` | `agency:write` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Agent Banking / Commissions | `/agency/commission` | `agency:reports` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Agent Banking / Settlements | `/agency/payables` | `agency:reports` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Agent Banking / Cash reconciliation | `/agency/reconciliation/cash` | `agency:reconcile` | MO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Agent Banking / Float reconciliation | `/agency/reconciliation/float` | `agency:reconcile` | MO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Agent Banking / Banking reports | `/agency/reports?scope=banking` | `agency:reports` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Agent Banking / Banks & Agent Accounts / All banks & accounts | `/agency/banking/accounts` | `agency:reports` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Agent Banking / Banks & Agent Accounts / Register a bank | `/agency/providers` | `agency:providers` | O | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Agent Banking / Banks & Agent Accounts / Register an agent account | `/agency/lines` | `agency:providers` | O | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Agent Banking / Banks & Agent Accounts / Account authorisations | `/agency/staffing?category=agency_banking` | `agency:settlements` | MO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Mobile Money / Overview | `/agency/money` | `agency:reports` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Mobile Money / Line authorisations | `/agency/staffing?category=mobile_money` | `agency:settlements` | MO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Consolidated Agency Reports / Overview | `/agency/reports` | `agency:reports` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Consolidated Agency Reports / Transaction reports | `/agency/reports?section=transactions` | `agency:reports` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Consolidated Agency Reports / Cash & float reports | `/agency/reports?section=cash-float` | `agency:reports` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Consolidated Agency Reports / Commission reports | `/agency/reports?section=commission` | `agency:reports` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Consolidated Agency Reports / Settlement reports | `/agency/reports?section=settlements` | `agency:reports` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Consolidated Agency Reports / Reconciliation reports | `/agency/reports?section=reconciliation` | `agency:reports` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Consolidated Agency Reports / Agent performance | `/agency/reports?section=performance` | `agency:reports` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Consolidated Agency Reports / Audit & exception reports | `/agency/exceptions` | `agency:reports` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |
| Consolidated Agency Reports / Export centre | `/agency/reports?section=export` | `agency:reports` | SMO | Implemented | yes | yes | User 19–22 · Admin 7–11 |

## Reports

| Submodule / entry | Route | Capability | Roles | Status | Desktop | Mobile | Chapter |
| --- | --- | --- | :---: | --- | :---: | :---: | --- |
| Reports Centre | `/reports` | `reports:view_operational` | SMO | Implemented | yes | yes | User 23 |
| Collections Reports | `/reports?group=money-in` | `reports:view_operational` | SMO | Implemented | yes | yes | User 23 |
| Arrears & Risk Reports | `/reports?group=behind` | `reports:view_operational` | SMO | Implemented | yes | yes | User 23 |
| Loan & Client Reports | `/reports?group=book` | `reports:view_operational` | SMO | Implemented | yes | yes | User 23 |
| Security & Guarantee Reports | `/reports?group=security` | `reports:view_operational` | MO | Implemented | yes | yes | User 23 |

## Branch Network

| Submodule / entry | Route | Capability | Roles | Status | Desktop | Mobile | Chapter |
| --- | --- | --- | :---: | --- | :---: | :---: | --- |
| Branches | `/settings?section=branches#branches-heading` | `settings:view` | SMO | Implemented | yes | yes | User 8 · Admin 3 |
| Branch Cash Position | `/finance?section=cash#cash-position-heading` | `ledger:view` | SMO | Implemented | yes | yes | User 8 · Admin 3 |
| Branch Performance | `/payments/summary?section=branch#by-branch` | `payments:view` | SMO | Implemented | yes | yes | User 8 · Admin 3 |
| Branch Portfolio | `/reports/aging` | `reports:view_operational` | MO | Implemented | yes | yes | User 8 · Admin 3 |

## Administration

| Submodule / entry | Route | Capability | Roles | Status | Desktop | Mobile | Chapter |
| --- | --- | --- | :---: | --- | :---: | :---: | --- |
| Users | `/users` | `users:view` | MO | Implemented | yes | yes | User 24 · Admin 2,4,12,13 |
| Loan Products | `/settings/products` | `products:view` | SMO | Implemented | yes | yes | User 24 · Admin 2,4,12,13 |
| Company Settings | `/settings` | `settings:view` | SMO | Implemented | yes | yes | User 24 · Admin 2,4,12,13 |
| Lending Rules | `/settings?section=lending#rules-heading` | `settings:view` | SMO | Implemented | yes | yes | User 24 · Admin 2,4,12,13 |
| Guarantor Rules | `/settings?section=guarantors#guarantors-heading` | `settings:view` | SMO | Implemented | yes | yes | User 24 · Admin 2,4,12,13 |
| Finance Settings | `/settings?section=finance#finance-heading` | `settings:view` | SMO | Implemented | yes | yes | User 24 · Admin 2,4,12,13 |
| Reference Numbers | `/settings?section=references#references-heading` | `settings:view` | SMO | Implemented | yes | yes | User 24 · Admin 2,4,12,13 |
| Audit Trail | `/audit` | `audit:view` | O | Implemented | yes | yes | User 24 · Admin 2,4,12,13 |
| My Account | `/account` | `account:view` | CSMO | Implemented | yes | yes | User 24 · Admin 2,4,12,13 |

## Capabilities with no screen behind them

Declared in the permission matrix and granted to a role, but no screen and no Server
Action calls them. Each is a documented gap, not a feature.

| Capability | Granted to | What it would do | Finding |
| --- | --- | --- | --- |
| `branches:create` | Owner / Administrator | Open a branch | F-01 |
| `branches:update` | Manager, Owner / Administrator | Edit a branch | F-01 |
| `finance:accounts` | Owner / Administrator | Create a branch's ledger accounts | F-01 |

## Routes that are not navigation entries

Reached from a register rather than from the rail — a detail page, an edit form or a
CSV export route. All are covered by the chapter that covers their register.

| Route |
| --- |
| `/account/password` |
| `/agency` |
| `/agency/accounts/[accountId]` |
| `/agency/float` |
| `/agency/history/[transactionId]` |
| `/agency/money/[providerCode]` |
| `/agency/money/[providerCode]/commission` |
| `/agency/money/[providerCode]/statements` |
| `/agency/reports/export` |
| `/api/health` |
| `/beneficiaries/[beneficiaryId]` |
| `/beneficiaries/new` |
| `/benefits/claims/[claimId]` |
| `/clients/[clientId]` |
| `/clients/[clientId]/edit` |
| `/finance/expenses/new` |
| `/finance/income/new` |
| `/finance/reconciliation/new` |
| `/finance/transfers/new` |
| `/finance/trial-balance/export` |
| `/guarantors/[guarantorId]` |
| `/guarantors/[guarantorId]/edit` |
| `/guarantors/new` |
| `/loans/[loanId]` |
| `/loans/[loanId]/application` |
| `/loans/[loanId]/edit` |
| `/loans/[loanId]/statement` |
| `/login` |
| `/manifest.webmanifest` |
| `/meetings/[meetingId]` |
| `/meetings/actions/[recordId]` |
| `/meetings/fines` |
| `/meetings/fines/[fineId]` |
| `/meetings/notices/[recordId]` |
| `/membership/[membershipId]` |
| `/membership/policies/transitions` |
| `/notifications` |
| `/offline` |
| `/payments/[paymentId]` |
| `/portal` |
| `/portal/loans/[loanId]` |
| `/reports/aging/export` |
| `/reports/arrears/export` |
| `/reports/clients` |
| `/reports/clients/export` |
| `/reports/collateral` |
| `/reports/collateral/export` |
| `/reports/collections/export` |
| `/reports/grace` |
| `/reports/grace/export` |
| `/reports/guarantors/export` |
| `/reports/loans` |
| `/reports/loans/export` |
| `/reports/penalties/export` |
| `/reports/recovery/export` |
| `/savings/[savingsAccountId]` |
| `/savings/[savingsAccountId]/deposit` |
| `/savings/[savingsAccountId]/statement` |
| `/savings/[savingsAccountId]/withdraw` |
| `/savings/withdrawals/[requestId]` |
| `/settings/products/[productId]` |
| `/settings/products/new` |
| `/users/[profileId]` |
| `/users/new` |
