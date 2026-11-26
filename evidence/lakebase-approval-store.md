# Lakebase approval store: end-to-end run

Run on 2026-11-26 (07:26 to 07:34 UTC), `demo` target, after moving the approval record from Delta to Lakebase.
Identities and URLs are redacted (`<operator>`, `<approver-sp>`, `<app-sp>`).

## Deployment

| Object | Result |
|---|---|
| `postgres_projects.approval_store` (project `jit-access`, PG 17, 0.5 to 1 CU) | created by the bundle |
| `postgres_catalogs.approval_store_catalog` (UC catalog `jit_access_store`) | created by the bundle |
| App `postgres` resource (CAN_CONNECT_AND_CREATE) | created the app SP's Postgres role |
| Setup task `approval_store` | schema `jit_control`: `access_lifecycle`, `access_lifecycle_history` + trigger, `demo_settings`; grants to `<app-sp>` |
| `SHOW TABLES IN jit_access_store.jit_control` | the three tables, visible through Unity Catalog |
| Guard UDF definition | reads `jit_access_store` (checked in `information_schema.routines`) |

## Flow through the deployed portal (operator, demo auto-approver)

| Step | Result |
|---|---|
| Rate 100%, submit a 1-minute request | record `ACTIVE`, approver `<approver-sp>`, `DEMO_AUTO`, reason "drew 85.2 against a 100% approval rate -> approved" |
| Operator rows on the gated table | 0 before, **5000** after approval, **0** after the window (no job) |
| Rate 0%, submit again | `DENIED`, `DEMO_AUTO`, reason "drew 80.5 against a 0% approval rate -> declined" |
| Expiry job | `SUCCESS`; first record `EXPIRED`, closed by `expiry-job` |

History (`control.v_owner_access_history`, written by the trigger; `db_role` is the Postgres role that wrote):

| change | status | decision_source | db_role |
|---|---|---|---|
| INSERT | PENDING | | `<app-sp>` |
| UPDATE | ACTIVE | DEMO_AUTO | `<app-sp>` |
| INSERT | PENDING | | `<app-sp>` |
| UPDATE | DENIED | DEMO_AUTO | `<app-sp>` |
| UPDATE | EXPIRED | | `<operator>` (expiry job) |

## Database rules (direct Postgres, as the project owner)

| Attempt | Result |
|---|---|
| Set an EXPIRED record to ACTIVE with `approver_1 = principal` | `violates check constraint "no_self_approval"` |
| Two PENDING requests for the same principal and product | `violates unique constraint "one_pending_request"` |

App role privileges (`has_table_privilege` for `<app-sp>`):

| Table | SELECT | UPDATE | DELETE |
|---|---|---|---|
| `access_lifecycle` | yes | yes | **no** |
| `access_lifecycle_history` | **no** | **no** | **no** |
| `demo_settings` | yes | yes | **no** |

Unit tests: 20/20 (including `toPositional`, the `:name` to `$n` parameter mapping for Postgres).

Not run here: `scripts/scenario_test.py` (needs the test service principal's OAuth secret). It is updated for
the Lakebase store (reads via the UC catalog, direct writes via Postgres, history view instead of CDF).
