# Probe: does the Lakebase-backed guard need users to have access to the Lakebase catalog?

Run on 2026-11-26 on serverless job compute, **as the test service principal** (`<analyst-sp>`, job `run_as`),
which is in `account users` and holds **no** grant on the registered Lakebase catalog. Temporary Lakebase
project and catalog, deleted afterwards.

Setup: Postgres table `probe.approvals(principal, expires_at)` with one row for `<analyst-sp>`; UC SQL UDF in
the control schema reading the Lakebase catalog (`EXISTS ... WHERE principal = current_user() AND now() < expires_at`)
applied as a row filter on a 100-row Delta table; UC view in the control schema over the Lakebase table filtered
by `current_user()`, with SELECT granted to `account users`.

| Check (as `<analyst-sp>`) | Approval valid | Approval expired in Postgres |
|---|---|---|
| `current_user()` | `<analyst-sp>` | `<analyst-sp>` |
| Guarded Delta table (guard reads Lakebase) | **100** rows | **0** rows |
| UC view over the Lakebase table (own rows) | 1 row | 1 row (the expired record itself) |
| Direct `SELECT` on the Lakebase catalog | `INSUFFICIENT_PERMISSIONS` | `INSUFFICIENT_PERMISSIONS` |

Conclusion: the guard and views evaluate the Lakebase catalog with the **owner's** (definer's) rights, while
`current_user()` is still the caller. End users need no access to the approval store; they see only what the
secure views expose. This removes the open question in `lakebase-rowfilter-test.md`.
