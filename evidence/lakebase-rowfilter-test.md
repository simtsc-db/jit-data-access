# Test: can the ABAC guard read approvals directly from Lakebase?

Run on 2026-11-26 (UTC 03:17 to 03:23) on a serverless SQL warehouse, with a temporary
Lakebase Autoscaling project (PG 17, 1 CU) registered in Unity Catalog as a read-only
Lakebase catalog. All test objects were deleted afterwards.

## Setup

- Postgres table `tba.access_lifecycle` in Lakebase, with CHECK constraints
  (no self-approval, ACTIVE needs approver and window). One ACTIVE row for the caller,
  window now-5 min to now+1 h.
- Lakebase database registered in Unity Catalog (`databricks postgres create-catalog`).
- Guard UDF in the Delta control schema that runs `EXISTS (...)` against
  `<lakebase_catalog>.tba.access_lifecycle`, checking `current_user()` and `current_timestamp()`.
- Protected Delta table with 100 synthetic rows (`range(100)`).

## Results

| # | Step | Result |
|---|------|--------|
| 1 | `SELECT` the Lakebase table from the SQL warehouse | Works (5.0 s first call, metadata + connect) |
| 2 | Create a UC SQL UDF that reads the Lakebase catalog | Works |
| 3 | Call the guard directly | `true` |
| 4 | Apply as table row filter (`ALTER TABLE ... SET ROW FILTER`) and count | 100 of 100 rows |
| 5 | Set `expires_at = now()-1s` **in Postgres**, query again 1.5 s later | 0 rows (no sync lag) |
| 6 | Extend the window in Postgres, query again | 100 rows |
| 7 | Apply as **ABAC policy** (`CREATE POLICY ... ON TABLE ... ROW FILTER ... USING COLUMNS ('citizen_cases')`) | 100 rows |
| 8 | Expire in Postgres, query again | 0 rows |
| 9 | Disable the Lakebase endpoint, query the protected table | Query **fails** with `FAILED_JDBC.CONNECTION` (fails closed, no rows leak) |

Query latency with the guard: 0.7 to 1.1 s on a warm warehouse for this table.

## Not tested

> Resolved later: [`lakebase-identity-probe.md`](lakebase-identity-probe.md) shows the guard runs with the
> owner's rights, so end users need no access to the Lakebase catalog.


- A second identity that has **no** `SELECT` on the Lakebase catalog. Creating a
  temporary secret for the test service principal was not authorised in this run, so
  whether the guard executes with the policy owner's rights on the Lakebase catalog
  (so end users need no access to the approval store) is still open.
- Classic or Pro compute. Per docs, Lakebase catalogs need serverless compute, so the
  guard would fail (closed) on classic clusters reading a protected table.
- Scale-to-zero cold start inside a guarded query.
