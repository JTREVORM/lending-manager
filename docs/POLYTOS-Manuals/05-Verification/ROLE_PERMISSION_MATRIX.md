# POLYTOS — Role & Permission Matrix

Generated from `lib/permissions/roles.ts` and `lib/permissions/permissions.ts`,
which migration `20261002000100_permission_matrix.sql` mirrors into
`public.role_permissions`. A database test asserts the two representations
are identical, so this table is also the Row Level Security rule set.

**4 roles · 130 capabilities · 38 resources**

## The roles

| Role key | Label | Rank | Staff? | Capabilities held |
| --- | --- | ---: | :---: | ---: |
| `client` | Client | 10 | no | 3 |
| `secretary_treasurer` | Secretary / Treasurer | 30 | yes | 54 |
| `manager` | Manager | 50 | yes | 96 |
| `owner_admin` | Owner / Administrator | 70 | yes | 129 |

Rank orders roles in the interface and enforces the rule that an administrator
may not assign a role outranking their own. It does **not** derive permissions:
every grant below is listed by hand, so a new capability is held by nobody
until somebody decides who should have it. A profile may hold several roles,
and the effective set is their union — there are no deny rules.

## The matrix

`Y` = granted. Blank = not granted.

### `membership_policy`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `membership_policy:manage` |  |  |  | Y |

### `meetings`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `meetings:excuse_review` |  |  | Y | Y |
| `meetings:view` |  | Y | Y | Y |
| `meetings:manage` |  | Y | Y | Y |

### `fines`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `fines:view` |  | Y | Y | Y |
| `fines:assess` |  |  | Y | Y |
| `fines:collect` |  | Y | Y | Y |
| `fines:reverse` |  |  |  | Y |

### `dashboard`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `dashboard:view` |  | Y | Y | Y |

### `account`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `account:view` | Y | Y | Y | Y |
| `account:update` | Y | Y | Y | Y |

### `portal`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `portal:view` | Y |  |  |  |

### `users`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `users:view` |  |  | Y | Y |
| `users:create` |  |  |  | Y |
| `users:update` |  |  |  | Y |
| `users:disable` |  |  |  | Y |
| `users:assign_role` |  |  |  | Y |
| `users:reset_password` |  |  |  | Y |

### `settings`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `settings:view` |  | Y | Y | Y |
| `settings:update` |  |  |  | Y |

### `audit`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `audit:view` |  |  |  | Y |

### `branches`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `branches:view` |  | Y | Y | Y |
| `branches:create` |  |  |  | Y |
| `branches:update` |  |  | Y | Y |

### `ledger`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `ledger:view` |  | Y | Y | Y |
| `ledger:post` |  |  |  | Y |

### `transfers`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `transfers:view` |  | Y | Y | Y |
| `transfers:create` |  | Y | Y | Y |
| `transfers:approve` |  |  | Y | Y |

### `expenses`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `expenses:view` |  | Y | Y | Y |
| `expenses:create` |  | Y | Y | Y |
| `expenses:approve` |  |  | Y | Y |

### `income`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `income:view` |  | Y | Y | Y |
| `income:create` |  | Y | Y | Y |

### `reconciliation`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `reconciliation:view` |  | Y | Y | Y |
| `reconciliation:perform` |  | Y | Y | Y |
| `reconciliation:approve` |  |  | Y | Y |

### `finance`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `finance:settings` |  |  |  | Y |
| `finance:accounts` |  |  |  | Y |

### `receipts`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `receipts:view` |  | Y | Y | Y |
| `receipts:confirm` |  |  | Y | Y |

### `deposits`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `deposits:view` |  | Y | Y | Y |
| `deposits:create` |  | Y | Y | Y |
| `deposits:verify` |  |  | Y | Y |
| `deposits:reverse` |  |  |  | Y |

### `guarantor_terms`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `guarantor_terms:manage` |  |  |  | Y |

### `products`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `products:view` |  | Y | Y | Y |
| `products:manage` |  |  |  | Y |

### `membership`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `membership:view` |  | Y | Y | Y |
| `membership:create` |  |  | Y | Y |
| `membership:update` |  |  | Y | Y |
| `membership:manage_status` |  |  | Y | Y |
| `membership:manage_policies` |  |  |  | Y |
| `membership:view_sensitive` |  |  | Y | Y |

### `savings`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `savings:view` |  | Y | Y | Y |
| `savings:deposit` |  | Y | Y | Y |
| `savings:request_withdrawal` |  | Y | Y | Y |
| `savings:approve_withdrawal` |  |  | Y | Y |
| `savings:post_withdrawal` |  |  | Y | Y |
| `savings:reverse` |  |  |  | Y |
| `savings:view_reports` |  |  | Y | Y |

### `member_loans`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `member_loans:view_eligibility` |  | Y | Y | Y |
| `member_loans:create` |  |  | Y | Y |

### `beneficiaries`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `beneficiaries:view` |  | Y | Y | Y |
| `beneficiaries:manage` |  | Y | Y | Y |
| `beneficiaries:verify` |  |  | Y | Y |

### `benefits`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `benefits:view` |  | Y | Y | Y |
| `benefits:claim` |  | Y | Y | Y |
| `benefits:assess` |  |  | Y | Y |
| `benefits:approve` |  |  |  | Y |
| `benefits:pay` |  |  | Y | Y |

### `clients`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `clients:view` |  | Y | Y | Y |
| `clients:create` |  |  | Y | Y |
| `clients:update` |  | Y | Y | Y |
| `clients:status` |  |  | Y | Y |
| `clients:blacklist` |  |  |  | Y |
| `clients:archive` |  |  |  | Y |
| `clients:documents` |  |  | Y | Y |
| `clients:view_nin` |  |  | Y | Y |
| `clients:link_auth` |  |  |  | Y |
| `clients:remarks_view` |  | Y | Y | Y |
| `clients:remarks_create` |  |  | Y | Y |

### `guarantors`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `guarantors:view` |  | Y | Y | Y |
| `guarantors:create` |  |  | Y | Y |
| `guarantors:update` |  |  | Y | Y |
| `guarantors:documents` |  |  | Y | Y |
| `guarantors:view_nin` |  |  | Y | Y |
| `guarantors:link` |  |  | Y | Y |
| `guarantors:release` |  |  | Y | Y |

### `loans`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `loans:view` |  | Y | Y | Y |
| `loans:create` |  | Y | Y | Y |
| `loans:update_draft` |  | Y | Y | Y |
| `loans:submit` |  | Y | Y | Y |
| `loans:approve` |  |  | Y | Y |
| `loans:disburse` |  |  |  | Y |
| `loans:cancel` |  |  |  | Y |
| `loans:documents` |  | Y | Y | Y |
| `loans:view_sensitive` |  |  | Y | Y |

### `schedules`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `schedules:view` |  | Y | Y | Y |

### `payments`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `payments:view` |  | Y | Y | Y |
| `payments:create` |  | Y | Y | Y |
| `payments:reverse` |  |  |  | Y |

### `delinquency`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `delinquency:view` |  | Y | Y | Y |

### `penalties`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `penalties:view` |  | Y | Y | Y |

### `notifications`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `notifications:view` |  | Y | Y | Y |

### `collateral`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `collateral:view` |  | Y | Y | Y |
| `collateral:manage` |  | Y | Y | Y |

### `recovery`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `recovery:view` |  | Y | Y | Y |
| `recovery:record` |  | Y | Y | Y |

### `reports`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `reports:view_operational` |  | Y | Y | Y |
| `reports:view_financial` |  |  | Y | Y |
| `reports:view_sensitive` |  |  |  | Y |

### `agency`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `agency:write` |  | Y | Y | Y |
| `agency:verify` |  |  | Y | Y |
| `agency:reverse` |  |  | Y | Y |
| `agency:reverse_cross_day` |  |  |  | Y |
| `agency:correct` |  |  | Y | Y |
| `agency:settlements` |  |  | Y | Y |
| `agency:float_trade` |  | Y | Y | Y |
| `agency:reconcile` |  |  | Y | Y |
| `agency:providers` |  |  |  | Y |
| `agency:variance_adjustment` |  |  |  | Y |
| `agency:commission_exception` |  |  |  | Y |
| `agency:reports` |  | Y | Y | Y |
| `agency:provider_approval` |  |  |  | Y |
| `agency:verify_high_value` |  |  | Y | Y |

### `capital`

| Capability | Client | Secretary / Treasurer | Manager | Owner / Administrator |
| --- | :---: | :---: | :---: | :---: |
| `capital:view` |  |  | Y | Y |
| `capital:record` |  |  | Y | Y |
| `capital:verify` |  |  |  | Y |
| `capital:reverse` |  |  |  | Y |
