# Setup evidence (<profile>, 2026-11-25 07:21 UTC)

> Captured in November 2026 on an earlier, **Delta-based** version of this repo (approval record in a Delta
> table with CDF; now in Lakebase, see `lakebase-approval-store.md`). Object names were rewritten to the
> current defaults (`jit_access`, `jit-access-*`), and identities, URLs and the CLI profile are redacted.

## Bundle resources
```
Resources:
  Apps:
    access_portal:
      Name: jit-access-portal
      URL:  <portal-url>
  Jobs:
    tba_expiry:
      Name: [dev <user>] jit-access-expiry
      URL:  <workspace-url>/...
    tba_setup:
      Name: [dev <user>] jit-access-setup
      URL:  <workspace-url>/...
```
## Setup job runs (latest first; the two failures are the tag-propagation fix iterations)
```
575186089160827 SUCCESS 
949028892345010 FAILED Task governance failed with message: Workload failed, see run output for details. This cau
48694639996416 FAILED Task generate_data failed with message: Workload failed, see run output for details. This 
```
## ABAC policies on jit_access.gated_data
```
{"name": "tba_deny_manage_access_data", "policy_type": "POLICY_TYPE_DENY", "to_principals": ["account users"], "except_principals": ["<operator>"], "for_securable_type": "TABLE", "deny": {"privileges": ["MANAGE_ACCESS_CONTROL"]}}
{"name": "tba_guard_citizen_cases", "policy_type": "POLICY_TYPE_ROW_FILTER", "to_principals": ["account users"], "for_securable_type": "TABLE", "when_condition": "has_tag_value('jit_access_product', 'citizen_cases')", "row_filter": {"function_name": "jit_access.control.tba_has_active_access", "using": [{"constant": "'citizen_cases'"}]}}
```
## Grants (group-level only)
```
catalog jit_access: [('account users', ['USE_CATALOG']), ('<app-sp>', ['USE_CATALOG'])]
schema jit_access.gated_data: [('account users', ['SELECT', 'USE_SCHEMA'])]
schema jit_access.control: [('<app-sp>', ['USE_SCHEMA'])]
(<app-sp> = the app's service principal; it has MODIFY only on control.access_lifecycle)
```
## Request for Access destination (table)
```
[('URL', '<portal-url>/?securable=jit_access.gated_data.citizen_cases')]
```
## Lifecycle constraints
```
delta.constraints.active_needs_window = status <> 'ACTIVE' OR (approver_1 IS NOT NULL AND starts_at IS NOT NULL AND expires_at > starts_at)
delta.constraints.distinct_approvers = approver_2 IS NULL OR approver_2 <> approver_1
delta.constraints.no_self_approval = coalesce(approver_1,'') NOT IN (principal, requested_by) AND coalesce(approver_2,'') NOT IN (principal, requested_by)
delta.constraints.positive_duration = duration_minutes > 0
delta.constraints.valid_status = status IN ('PENDING','PENDING_SECOND','ACTIVE','DENIED','EXPIRED','REVOKED','TIMED_OUT')
delta.enableChangeDataFeed = true
```
## Expiry runs
```
[
  {
    "expired": "1",
    "run_at": "2026-11-25T07:17:16.222Z",
    "still_active": "0",
    "timed_out": "0"
  }
]
```
## App (AppKit)
```
url: <portal-url>
app_status: RUNNING  compute: ACTIVE
active deployment: SUCCEEDED
user_api_scopes: ['sql']
framework: AppKit (@databricks/appkit 0.84.0), analytics plugin; `databricks apps validate` passed (typegen, lint, typecheck, build, tests)
```
## Portal secure views (granted to `account users`; base control tables are not)
```
v_my_access: [('account users', ['SELECT'])]
v_review_queue: [('account users', ['SELECT'])]
v_owner_access_review: [('account users', ['SELECT'])]
data_products: [('account users', ['SELECT']), ('<app-sp>', ['SELECT'])]
access_lifecycle: [('<app-sp>', ['MODIFY', 'SELECT'])]
```
