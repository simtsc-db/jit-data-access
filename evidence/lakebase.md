# Evidence: Lakebase approval store

Runs on 2026-11-26 on a deployed `demo` target, serverless compute. Identities are redacted:
`<operator>` (presenter, owner group), `<analyst-sp>` (test service principal), `<approver-sp>` (demo
auto-approver) and `<app-sp>` (portal).

## 1. The guard can read Lakebase directly

Temporary project, with the approval table registered in Unity Catalog and a UC SQL UDF reading it.

| Check | Result |
|---|---|
| UDF as table row filter, and as ABAC policy | 100 of 100 rows with a valid approval |
| Expire or extend in Postgres, then query again about 1.5 s later | 0 rows / 100 rows (no sync lag) |
| Lakebase endpoint disabled | Query fails with `FAILED_JDBC.CONNECTION` (fails closed) |

## 2. Users need no access to the store

A job runs as `<analyst-sp>`, which has no grant on the Lakebase catalog.

| Check | Approval valid | Approval expired |
|---|---|---|
| Gated table (guard reads Lakebase) | 100 rows | 0 rows |
| Secure view over the store (own rows) | 1 row | 1 row |
| Direct `SELECT` on the store catalog | `INSUFFICIENT_PERMISSIONS` | `INSUFFICIENT_PERMISSIONS` |

The guard and views run with the owner's rights; `current_user()` stays the caller.

## 3. End to end through the deployed portal

| Step | Result |
|---|---|
| Auto-approver at 100%, 1-minute request | ACTIVE within 8 s, approver `<approver-sp>`, `DEMO_AUTO`; reason states the draw and rate |
| Operator rows on the gated table | 0 before, **5000** after approval, **0** after the window (no job) |
| Auto-approver at 0% | DENIED, `DEMO_AUTO` |
| Expiry job | Record EXPIRED, closed by `expiry-job` |
| History (`v_owner_access_history`) | INSERT PENDING, UPDATE ACTIVE, INSERT PENDING, UPDATE DENIED by `<app-sp>`; UPDATE EXPIRED by `<operator>` |

## 4. Database rules (direct Postgres write as the owner)

| Attempt | Result |
|---|---|
| Set a record ACTIVE with `approver_1 = principal` | `violates check constraint "no_self_approval"` |
| Second PENDING request for the same principal and product | `violates unique constraint "one_pending_request"` |
| `<app-sp>` privileges | SELECT, INSERT and UPDATE on `access_lifecycle` and `demo_settings`; no DELETE; no access to the history table |

Unit tests: 20/20.
