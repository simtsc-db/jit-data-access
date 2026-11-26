# Demo runbook

About 10 minutes live. Outcome first: access that starts only after approval and **ends on the second**,
enforced by Unity Catalog, not by a cleanup job. Names are bundle defaults; substitute yours if overridden.

| Placeholder | Default |
|---|---|
| `<table>` | `jit_access.gated_data.citizen_cases` |
| `<catalog>` | `jit_access` |
| `<owner_group>` | `admins` (`jit-access-owners` with `-t demo`) |

## Who you need

The requester can never approve their own request, so either:

- **Two people:** you as approver (in `<owner_group>`) and a requester in `account users`, not in
  `<owner_group>`, with SQL access and **Can use** on the app and warehouse. Use two browser profiles.
- **Solo:** deploy with `-t demo`. A separate service principal decides each request about 3 s after submit, at
  the rate set by the slider in **Review queue** (100% always approves, 0% always declines).

### Solo setup (once)

```bash
databricks service-principals create --json '{"displayName":"jit-demo-approver","entitlements":[{"value":"databricks-sql-access"}]}' -p <profile>
databricks groups create --json '{"displayName":"jit-access-owners","members":[{"value":"<your-user-id>"},{"value":"<approver-sp-id>"}]}' -p <profile>
databricks permissions update warehouses <warehouse-id> --json '{"access_control_list":[{"service_principal_name":"<approver-app-id>","permission_level":"CAN_USE"}]}' -p <profile>
databricks secrets create-scope jit-access-demo -p <profile>
printf '%s' '<approver-app-id>' | databricks secrets put-secret jit-access-demo client-id -p <profile>
databricks service-principal-secrets-proxy create <approver-sp-id> -p <profile> -o json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["secret"], end="")' \
  | databricks secrets put-secret jit-access-demo client-secret -p <profile>
```

Keep the approver out of `admins` (that would make it a workspace admin). Never deploy `-t demo` to production.

## Before the demo

- Day before: deploy and run setup and the app (README), rehearse once with the real requester (their first visit
  asks for consent to the `sql` scope).
- 15 minutes before:
  - The app opens for both users.
  - `SELECT count(*) FROM <table>` as the requester returns 0. Run it once to warm the warehouse and the approval store.
  - **Review queue** is empty, and the requester has no PENDING or ACTIVE request. Decline any leftovers with the
    reason `demo reset`.

## Walkthrough

| # | Who | Do | Expect | Say |
|---|---|---|---|---|
| 1 | | | | "Grants never expire; someone has to remember to revoke. We move the end date into the query engine." |
| 2 | Requester | `SELECT count(*) FROM <table>` | **0**, no error | "Right group, no approval: nothing." |
| 3 | Requester | Portal, **Request access**: 3 minutes, justification, submit | **My access**: PENDING | "The request is a record, not an email." |
| 4 | Approver | **Review queue**: Approve (solo: the bot decides) | Window starts now | "Only owners approve, checked as the signed-in user." |
| 5 | Requester | **My access** -> Refresh; rerun the query | ACTIVE, **5000** rows | |
| 6 | Approver | Request for yourself, then Approve it (two-person only) | "Self-approval is not allowed"; decline it | "Blocked in the app and by a database constraint." |
| 7 | Requester | Rerun the query after `expires_at` | **0**, status EXPIRED | "Nobody revoked anything." |
| 8 | Approver | **Access review** tab; optionally the history query below | Full trail | "Every change, with who made it." |

Solo variant: set the slider to 0% and submit again to show an automatic decline. Skip step 6; instead point out
the `no_self_approval` constraint.

```sql
SELECT changed_at, change_type, principal, status, approver_1, decision_source, db_role
FROM <catalog>.control.v_owner_access_history ORDER BY history_id DESC LIMIT 20;
```

If asked how it works: the guard is `DESCRIBE FUNCTION EXTENDED <catalog>.control.tba_has_active_access`. Users
cannot forge approvals, because only the app's Postgres role writes the store and a trigger logs every change.
The limits (0 rows instead of an error, copies outlive the window, tables only) are listed in the README.

## Reset and fallback

- Reset: decline PENDING requests, let windows expire (use 3 minutes), then run the expiry job. History is kept on purpose.
- Fallback: `scripts/scenario_test.py` drives the deployed portal as two identities and prints 17 checks (about
  5 min). It needs a test service principal's OAuth secret in `TBA_TEST_SP_CLIENT_ID` / `TBA_TEST_SP_SECRET`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Requester sees rows before approval | Remove them from the standing-access group; rerun setup |
| "You are not in owner group" | Add the approver to `<owner_group>` |
| "An open request or active window already exists" | Decline it or wait for expiry |
| No "minutes" option | `demo_mode` is off (prod target) |
| Error banner on load, or the first query is slow | Restart the app; the warehouse or approval store was asleep |
