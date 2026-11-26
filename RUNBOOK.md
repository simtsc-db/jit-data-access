# Demo runbook: approval-gated, time-bound access

About 10 minutes live, plus 15 minutes of preparation the day before. Outcome first: access that starts only
after approval and **ends on the second**, enforced by Unity Catalog, not by a cleanup job.

Names below are the bundle defaults. If you overrode variables, substitute your values:

| Placeholder | Default |
|---|---|
| `<profile>` | your Databricks CLI profile |
| `<catalog>` | `jit_access` |
| `<table>` | `jit_access.gated_data.citizen_cases` |
| `<app>` | `jit-access-portal` |
| `<expiry-job>` | `[dev <user>] jit-access-expiry` (dev target) |
| `<owner_group>` | `admins` |
| `<store_catalog>` | `jit_access_store` (Lakebase approval store, registered in Unity Catalog) |

## Cast

You need **two human identities**, because the requester can never approve their own request.

| Role | Who | Requirements |
|---|---|---|
| **Approver** (data owner) | You, the presenter | Member of `<owner_group>`; `CAN_USE` on the app |
| **Requester** (analyst) | A colleague, or a second test user you control | Workspace user in `account users`, **not** in `<owner_group>` or the standing-access group; Databricks SQL entitlement; `CAN_USE` on the app and the SQL warehouse |

Use two browser profiles (or one normal and one private window) so both sessions stay signed in side by side.
The requester's screen is the one you share most.

> Presenting alone? Use the `demo` target with the demo auto-approver instead of a second human; see
> [Solo presenter](#solo-presenter-demo-auto-approver).

## Solo presenter: demo auto-approver

The `demo` bundle target adds a **separate service principal** that decides each new request about 3 seconds
after it is submitted. You set its approval rate with a slider in the **Review queue** tab: **100%** always
approves, **0%** always declines, anything in between approves at random at that rate. It is checked like any
approver (owner group membership, no self-approval), and the record is marked `DEMO_AUTO` with the draw and
rate in the decision reason. Never deploy the `demo` target to production.

One-time setup (names are the defaults; adjust if you override the `demo_approver_*` variables):

```bash
# 1. Approver service principal with SQL access, and the owner group holding you + the approver
databricks service-principals create --json '{"displayName":"jit-demo-approver","entitlements":[{"value":"databricks-sql-access"}]}' -p <profile>
databricks groups create --json '{"displayName":"jit-access-owners","members":[{"value":"<your-user-id>"},{"value":"<approver-sp-id>"}]}' -p <profile>
databricks permissions update warehouses <warehouse-id> --json '{"access_control_list":[{"service_principal_name":"<approver-app-id>","permission_level":"CAN_USE"}]}' -p <profile>

# 2. Its credentials in a secret scope (the secret goes straight from the API into the scope, never to disk)
databricks secrets create-scope jit-access-demo -p <profile>
printf '%s' '<approver-app-id>' | databricks secrets put-secret jit-access-demo client-id -p <profile>
databricks service-principal-secrets-proxy create <approver-sp-id> -p <profile> -o json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["secret"], end="")' \
  | databricks secrets put-secret jit-access-demo client-secret -p <profile>

# 3. Deploy with -t demo (owner group becomes jit-access-owners)
databricks bundle deploy -t demo -p <profile>
databricks bundle run tba_setup -t demo -p <profile>
databricks bundle run access_portal -t demo -p <profile>
```

Do not put the approver in `admins`: that would make it a workspace admin. The dedicated owner group avoids that.

Solo flow: set the slider to **100%** before you start. In Beat 3 you are the requester; skip Beat 4 (the
approver acts for you) and point at the Review queue card, which shows the last decision. To show a
decline, set the slider to **0%** and submit again (after the first window ends). For Beat 6 (self-approval),
the approver decides too fast to click Approve on your own request first; instead explain the two layers: the
portal rule, and the `no_self_approval` CHECK constraint on `access_lifecycle` in the Lakebase approval store.

## 1. Day before: deploy and verify

```bash
databricks bundle deploy -p <profile>
databricks bundle run tba_setup -p <profile>          # idempotent, about 3 min
databricks bundle run access_portal -p <profile>      # builds and starts the app
databricks apps get <app> -p <profile> -o json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["url"], d["app_status"]["state"], d["compute_status"]["state"])'
```

Expect the app URL and `RUNNING ACTIVE`. Then grant the requester access to the app
(Compute -> Apps -> `<app>` -> Permissions -> add the user with **Can use**) and to the SQL warehouse.

Rehearse once end to end with the real requester account. Their first app visit asks for consent to the `sql`
scope; get that out of the way now, not on stage.

## 2. 15 minutes before: pre-flight

| Check | How | Expect |
|---|---|---|
| App is up | Open the app URL as both users | Header shows each user's identity badge |
| Warehouse is warm | Run `SELECT 1` in the SQL editor | Returns in about 1 s (a cold start takes longer) |
| Approval store is awake | `SELECT count(*) FROM <store_catalog>.jit_control.demo_settings` (as the deployer) | Returns quickly; the first call after scale-to-zero is slower |
| Requester sees nothing | Requester, SQL editor: `SELECT count(*) FROM <table>` | `0` |
| No leftover open requests | Approver, **Review queue** tab | "Nothing to review" (or decline leftovers, reason "demo reset") |
| Requester has no open window | Requester, **My access** tab | No PENDING or ACTIVE rows |
| Tabs ready | Requester: SQL editor + app; Approver: app on **Review queue** | |

If the requester has an ACTIVE window from a rehearsal, either wait until it expires or pick a short duration in
rehearsals (3 minutes) so it is gone by showtime.

## 3. Live walkthrough (about 10 min)

### Beat 1. The problem (1 min, no clicks)

> "Unity Catalog grants never expire. Someone has to remember to revoke them. Today we move the end date out of
> people's calendars and into the query engine."

### Beat 2. No approval, no data (1 min, requester)

1. SQL editor: `SELECT count(*) FROM <table>` -> **0**.
2. Point out: no error, and the table is visible. The user holds the standing group grant, but the guard returns
   no rows without an approved window.

> "This user is in the right group. That alone gets them nothing."

### Beat 3. Request (2 min, requester)

1. Open the app. **Request access** tab. The product is preselected when you arrive through the Unity Catalog *Request access* redirect
   (`?securable=<table>`, set by `scripts/configure_rfa.sh`).
2. Show **Rules for this product** on the right: sensitivity tier, maximum window, approvals required, approver group.
3. Duration **3**, unit **minutes (demo mode)**. Justification: `Quarterly case backlog analysis, ticket DEMO-101`.
4. Submit. **My access** tab: the request is **PENDING**; live visibility still says 0 rows.

> "The request is a record in Unity Catalog, not an email. The user cannot edit it; the platform writes it."

### Beat 4. Approve (1 min, approver)

1. **Review queue** tab: the request shows principal, justification, duration.
2. Click **Approve**. The window starts now and ends in 3 minutes.

> "Only the owner group can approve, and that check runs as me, the signed-in approver, not as the app."

### Beat 5. Access is live (1 min, requester)

1. **My access** -> **Refresh**: status **ACTIVE**, time remaining, live visibility shows **5,000** rows.
2. SQL editor: rerun `SELECT count(*) FROM <table>` -> **5000**. Same query, same user, now with an approved window.

### Beat 6. Self-approval is blocked (1 min, approver, while the window runs)

1. As the approver, submit your own request in **Request access** (any duration, any justification).
2. **Review queue**: click **Approve** on your own request -> error **"Self-approval is not allowed"**.
3. Click **Decline** on it with reason `demo reset` so it does not linger.

> "This is enforced twice: in the app, and by a CHECK constraint on the table, so even a direct write fails."

### Beat 7. Expiry without a job (2 min, requester)

1. Keep the requester's SQL editor open. Watch the **time remaining** in **My access**.
2. After `expires_at`, rerun `SELECT count(*) FROM <table>` -> **0**.
3. **My access** now shows **EXPIRED**. On the approver side, **Access review** shows
   **EXPIRED (pending job close)** until the housekeeping job closes the record. That is the point:
   enforcement happened at the timestamp; the job is only bookkeeping.

> "Nobody revoked anything. The guard compares now() with the approved window on every query."

### Beat 8. Audit trail (1 min, approver)

1. **Access review** tab: KPIs (active windows, pending decisions, expiring within 7 days) and the full table.
2. Optional, in the SQL editor:

```sql
SELECT changed_at, change_type, principal, status, approver_1, decision_source, db_role
FROM <catalog>.control.v_owner_access_history
ORDER BY history_id DESC
LIMIT 20;
```

   The history is written by a trigger in the Lakebase approval store; the app cannot edit it.

3. Optional: run the expiry job (Jobs -> `<expiry-job>` -> Run now) and show the record move to **EXPIRED**.

> "Every request, approval and expiry is one row history in Unity Catalog, ready for access reviews."

## 4. If asked: under the hood (governance audience only)

- The guard: `DESCRIBE FUNCTION EXTENDED <catalog>.control.tba_has_active_access;`
- Why users cannot forge approvals: they have only `USE SCHEMA` on `control` and SELECT on caller-filtered
  views; the approval store lives in Lakebase, where only the app's Postgres role can write (no DELETE), and every
  change is logged by a trigger.
- Why owners cannot grant around the flow: the optional DENY policy on `MANAGE ACCESS CONTROL` (Beta).
- Limits to state honestly: row-level gating (0 rows, not an error), data copied during a window outlives it,
  tables only. See README "Known limitations".

## 5. Reset between runs

- Decline any PENDING requests in **Review queue** (reason `demo reset`).
- Let ACTIVE windows expire (use 3 minute windows in rehearsals), then run the expiry job to close them.
- History is never deleted; that is intended. The **Access review** tab shows all runs.
- Changing data or rules: `databricks bundle run tba_setup -p <profile>` is idempotent and keeps the lifecycle history.

## 6. Fallback: scripted run

If the requester cannot join, or the app misbehaves, run the end-to-end test while you narrate. It drives the
deployed portal as two identities (you plus a test service principal) and prints each check:

```bash
export TBA_TEST_SP_CLIENT_ID=... TBA_TEST_SP_SECRET=...     # env only, never on disk
python scripts/scenario_test.py --profile <profile> --warehouse-id <id> --expiry-job-id <id> --window-minutes 3
```

About 5 minutes; writes `evidence/scenario-run.md` (redacted) with the 17 checks and the lifecycle history.

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Requester sees rows before approval | Requester is in the standing-access group, or the guard policy is missing | Check group membership; rerun `tba_setup` |
| "You are not in owner group" on approve | Approver not in `<owner_group>` | Add to the group, or redeploy with `--var owner_group=<group>` |
| "An open request or active window already exists" | Leftover from a rehearsal | Decline it, or wait for expiry |
| No "minutes" unit in the form | `demo_mode` is `false` (prod target) | Use the dev target, or request whole days |
| App shows an error banner on load | App stopped or warehouse unavailable | `databricks bundle run access_portal -p <profile>`; check the warehouse |
| Rows still visible right after `expires_at` | Query started before expiry, or clock skew of a few seconds | Rerun the query |
| Consent screen on first app visit | `sql` user scope needs one-time consent | Accept it; do this in rehearsal |
