# Scenario run: approval-gated, time-bound access (through the deployed AppKit portal)

> Captured in November 2026 on an earlier, **Delta-based** version of this repo (approval record in a Delta
> table with CDF; now in Lakebase, see `lakebase-approval-store.md`). Object names were rewritten to the
> current defaults (`jit_access`, `jit-access-*`), and identities, URLs and the CLI profile are redacted.

Run: 2026-11-25 08:23 UTC, profile `<profile>`, portal `<portal-url>`, table `jit_access.gated_data.citizen_cases` (synthetic). Requests and approvals go through the portal's HTTP API as two real identities. UC-layer checks also go straight to the warehouse.

**Result: 17/17 checks passed.**

| # | Check | Result | Detail |
|---|---|---|---|
| 1 | no access before approval (via app) | PASS | analyst sees 0 rows |
| 2 | analyst cannot forge an approval (direct SQL) | PASS | ServiceErrorCode.BAD_REQUEST: [INSUFFICIENT_PERMISSIONS] Insufficient privileges: |
| 3 | analyst cannot drop the ABAC guard | PASS | ServiceErrorCode.BAD_REQUEST: PERMISSION_DENIED: Principal 'jit-test-analyst' does not have MANAGE on Schema 'jit_access.gated_data'. |
| 4 | table owner cannot grant directly (DENY policy) | PASS | ServiceErrorCode.BAD_REQUEST: PERMISSION_DENIED: Principal 'jit-test-analyst' does not have MANAGE on Table 'jit_access.gated_data.owner_bypass_probe'. |
| 5 | self-approval rejected (app) | PASS | HTTP 403: Self-approval is not allowed |
| 6 | self-approval rejected (Delta CHECK constraint) | PASS | ServiceErrorCode.BAD_REQUEST: [DELTA_VIOLATE_CONSTRAINT_WITH_VALUES] CHECK constraint no_self_approval ((NOT (coalesce(approver_1, '') IN (principal, requested_by))) AND  |
| 7 | duration above tier max rejected (app) | PASS | HTTP 400: Duration must be between 1 minute and 7 days for tier Sensitive-High |
| 8 | non-owner cannot approve (app) | PASS | HTTP 403: You are not in owner group admins |
| 9 | first of two approvals does not grant | PASS | HTTP 200 status PENDING_SECOND, analyst sees 0 rows |
| 10 | same approver cannot approve twice (app) | PASS | HTTP 403: Second approval must come from a different approver |
| 11 | non-owner sees no queue or audit rows | PASS | review_queue 0 rows, owner_access_review 0 rows |
| 12 | my_access returns only the caller's rows | PASS | 3 own rows; operator's request not visible |
| 13 | access inside the window (via app) | PASS | analyst sees 5000 rows |
| 14 | other principals unaffected | PASS | operator (no window) sees 0 rows |
| 15 | access ends at expires_at without any job (via app) | PASS | analyst sees 0 rows; lifecycle status still `ACTIVE` |
| 16 | expiry job closes the record | PASS | job run 209837144877228 SUCCESS; status `EXPIRED` by `expiry-job` |
| 17 | change data feed has the full lifecycle | PASS | PENDING -> ACTIVE -> EXPIRED |

## Timeline
- `08:19:06 UTC` portal = <portal-url>; operator = `<operator>`, analyst = `<analyst-sp>` (identities as seen by the app, OBO)
- `08:19:09 UTC` PASS -- no access before approval (via app): analyst sees 0 rows
- `08:19:09 UTC` PASS -- analyst cannot forge an approval (direct SQL): ServiceErrorCode.BAD_REQUEST: [INSUFFICIENT_PERMISSIONS] Insufficient privileges:
- `08:19:10 UTC` PASS -- analyst cannot drop the ABAC guard: ServiceErrorCode.BAD_REQUEST: PERMISSION_DENIED: Principal 'jit-test-analyst' does not have MANAGE on Schema 'jit_access.gated_data'.
- `08:19:12 UTC` PASS -- table owner cannot grant directly (DENY policy): ServiceErrorCode.BAD_REQUEST: PERMISSION_DENIED: Principal 'jit-test-analyst' does not have MANAGE on Table 'jit_access.gated_data.owner_bypass_probe'.
- `08:19:19 UTC` PASS -- self-approval rejected (app): HTTP 403: Self-approval is not allowed
- `08:19:20 UTC` PASS -- self-approval rejected (Delta CHECK constraint): ServiceErrorCode.BAD_REQUEST: [DELTA_VIOLATE_CONSTRAINT_WITH_VALUES] CHECK constraint no_self_approval ((NOT (coalesce(approver_1, '') IN (principal, requested_by))) AND 
- `08:19:25 UTC` PASS -- duration above tier max rejected (app): HTTP 400: Duration must be between 1 minute and 7 days for tier Sensitive-High
- `08:19:31 UTC` PASS -- non-owner cannot approve (app): HTTP 403: You are not in owner group admins
- `08:19:37 UTC` PASS -- first of two approvals does not grant: HTTP 200 status PENDING_SECOND, analyst sees 0 rows
- `08:19:40 UTC` PASS -- same approver cannot approve twice (app): HTTP 403: Second approval must come from a different approver
- `08:19:46 UTC` PASS -- non-owner sees no queue or audit rows: review_queue 0 rows, owner_access_review 0 rows
- `08:19:46 UTC` PASS -- my_access returns only the caller's rows: 3 own rows; operator's request not visible
- `08:19:49 UTC` analyst submitted `813b0eaf-233d-4c4f-96e3-b2039c0c7c80` via the portal (HTTP 200, 3 min window)
- `08:19:54 UTC` operator approved via the portal (HTTP 200 ACTIVE); window 2026-11-25T08:19:52.257Z -> 2026-11-25T08:22:52.257Z
- `08:19:55 UTC` PASS -- access inside the window (via app): analyst sees 5000 rows
- `08:19:56 UTC` PASS -- other principals unaffected: operator (no window) sees 0 rows
- `08:19:56 UTC` waiting 180 s for expiry; expiry job deliberately NOT run yet
- `08:22:58 UTC` PASS -- access ends at expires_at without any job (via app): analyst sees 0 rows; lifecycle status still `ACTIVE`
- `08:23:32 UTC` PASS -- expiry job closes the record: job run 209837144877228 SUCCESS; status `EXPIRED` by `expiry-job`
- `08:23:34 UTC` PASS -- change data feed has the full lifecycle: PENDING -> ACTIVE -> EXPIRED

## Lifecycle record (change data feed)
| change | status | approver_1 | closed_by | commit |
|---|---|---|---|---|
| insert | PENDING | None | None | 2026-11-25T08:19:49.245Z |
| update_postimage | ACTIVE | <operator> | None | 2026-11-25T08:19:53.279Z |
| update_postimage | EXPIRED | <operator> | expiry-job | 2026-11-25T08:23:21.469Z |
