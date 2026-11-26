# Just-in-time data access on Databricks

Access to a sensitive data product is **granted only after approval** and **ends automatically at a set time**.
Unity Catalog enforces it at query time. Unity Catalog has no native time-to-live on grants, so this repo shows
a thin, build-on-top pattern: a standing group grant, an approval record in a **Lakebase Postgres** approval
store (registered in Unity Catalog, so no sync), and an ABAC row filter policy that checks the record against the
current time on every query.

Everything is synthetic and everything workspace-specific is a bundle variable (see [Configuration](#configuration)).

## Outcome

| KPI | Typical manual grant + ticket | With this pattern |
|---|---|---|
| Access still open after the approved end date | Until someone remembers to revoke | **0 s**: the guard stops returning rows at `expires_at` (evidence check 15) |
| Approvals that bypass the data owner | Possible (owners or admins grant directly) | Blocked: DENY `MANAGE ACCESS CONTROL` (Beta, check 4) |
| Self-approval | Policy only | Blocked in app logic **and** a Postgres CHECK constraint (checks 5 and 6) |
| Who can approve | Whoever can run GRANT | Only owner-group members, checked as the signed-in user (check 8) |
| Audit evidence for access reviews | Spread across tickets and grants | Append-only history table written by a trigger (check 17) |

## How it works

```
User opens the access portal (Databricks App): directly, from the table comment, or via
   UC "Request access" (redirect URL destination; shown to principals that lack SELECT)
   -> owner-group member approves (no self-approval, optional two-person rule, tier max duration)
   -> portal server: identity + owner check run AS THE USER (OBO); the write runs as the app SP
      in Lakebase Postgres (users have no Postgres role and no grant on the approval store)
   -> portal reads (*.obo.sql) hit caller-filtered secure views: own requests, owner-only queue and audit
   -> ABAC ROW FILTER policy on tables tagged <product_tag_key>=<id> calls
      control.tba_has_active_access(<id>), which reads the Lakebase store through its UC catalog:
      TRUE only while now() is inside an approved window (definer's rights, caller's identity)
   -> expiry job (every 15 min by default) closes records ACTIVE -> EXPIRED; enforcement does not depend on it
```

| Component | Object (default names) |
|---|---|
| Isolated catalog | `jit_access` (users get only USE CATALOG) |
| Data product (synthetic) | `jit_access.gated_data.citizen_cases`, 5,000 rows, tagged `jit_access_product=citizen_cases` |
| Standing grant | `account users`: USE SCHEMA + SELECT on `gated_data` (group-level only, no per-user grants) |
| System of record | Lakebase project `jit-access`, schema `jit_control`: `access_lifecycle` (7 CHECK constraints, partial unique index), append-only `access_lifecycle_history` (trigger), `demo_settings`; registered in UC as `jit_access_store` (read-only). Catalogue `jit_access.control.data_products` stays in Delta |
| Guard | UDF `control.tba_has_active_access` + ABAC policy `tba_guard_citizen_cases` |
| Bypass prevention | ABAC DENY policy `tba_deny_manage_access_data` (Beta, optional) |
| Review views | `v_active_access`, `v_expiring_soon`, `v_access_review` (platform); secure views for the portal: `v_my_access` (current_user()), `v_review_queue` and `v_owner_access_review` (owner group only) |
| Jobs | `<name_prefix>-setup` (idempotent), `<name_prefix>-expiry` (scheduled, serverless) |
| App | `<name_prefix>-portal`: **AppKit** (TypeScript/React, `src/portal`), analytics plugin with `*.obo.sql` reads, Express routes for writes, user scope `sql`, result cache disabled |

## Prerequisites

- A Unity Catalog workspace with serverless compute, a serverless SQL warehouse, Databricks Apps, and ABAC
  (row filter policies). ABAC DENY policies (Beta) are optional.
- Databricks CLI configured with a profile for the workspace (`databricks auth login`). No host, token or
  ID is stored in this repo.
- Permission to create a catalog (or point `catalog` at one you own), a governed tag, and grants to groups.

## Setup

```bash
databricks bundle deploy -p <profile>                       # dev target
databricks bundle run tba_setup -p <profile>                # ~3 min
databricks bundle run access_portal -p <profile>            # build + start the AppKit app
scripts/configure_rfa.sh <profile> jit_access.gated_data.citizen_cases [app-name]
# end-to-end test (needs a test service principal with an OAuth secret, passed via env only)
TBA_TEST_SP_CLIENT_ID=... TBA_TEST_SP_SECRET=... \
  python scripts/scenario_test.py --profile <profile> --warehouse-id <id> --expiry-job-id <id>
```

Portal development (`src/portal`): `cp .env.example .env` and fill it in, `npm ci`, `npm run dev` (runs
locally as your CLI profile user), `databricks apps validate --profile <profile>` (typegen, lint, typecheck,
build, unit tests). The test service principal needs `CAN_USE` on the app and on the warehouse.

## Configuration

All values are bundle variables in [`databricks.yml`](databricks.yml). Override with `--var name=value` or an
environment variable `BUNDLE_VAR_<name>`, for example:

```bash
export BUNDLE_VAR_catalog_storage_root=s3://<bucket>/<path>
databricks bundle deploy -p <profile> --var catalog=my_jit_catalog --var owner_group=data-owners
```

| Variable | Default | Purpose |
|---|---|---|
| `name_prefix` | `jit-access` | Prefix for the app and job names |
| `portal_title` | `Data Access Portal` | Portal header and browser tab title |
| `catalog` | `jit_access` | Dedicated catalog for control plane and data products |
| `catalog_storage_root` | empty | Managed location for the catalog; empty uses metastore default storage |
| `control_schema` / `data_schema` | `control` / `gated_data` | Schemas for the control plane and the gated tables |
| `warehouse_id` | lookup `Serverless Starter Warehouse` | Warehouse the app uses |
| `eligible_group` | `account users` | Group holding the standing SELECT grant |
| `standing_access_group` | `jit_standing_access` | Group exempt from the guard (e.g. stewards) |
| `owner_group` | `admins` | Group whose members may approve; use the data-owner group in production |
| `product_tag_key` / `product_tag_value` | `jit_access_product` / `citizen_cases` | Governed tag that marks a gated table |
| `demo_mode` | `true` (`false` in prod) | Allows minute-level durations for live demos |
| `synthetic_rows` / `synthetic_seed` | `5000` / `42` | Synthetic data volume and seed |
| `expiry_cron` / `expiry_timezone` | every 15 min / `UTC` | Schedule of the housekeeping job |
| `request_timeout_days` | `7` | PENDING requests older than this become TIMED_OUT |
| `lakebase_project` / `lakebase_catalog` / `lakebase_schema` | `jit-access` / `jit_access_store` / `jit_control` | Approval store project, its UC catalog, Postgres schema |
| `lakebase_min_cu` / `lakebase_max_cu` / `lakebase_suspend_timeout` | `0.5` / `1` / `3600s` | Lakebase compute size and scale-to-zero delay |
| `demo_approver_scope` / `..._client_id_key` / `..._secret_key` | `jit-access-demo` / `client-id` / `client-secret` | Secret scope and keys of the demo auto-approver (`demo` target only) |

### Targets

| Target | Use |
|---|---|
| `dev` (default) | Development deploy; two human identities needed to demo approval |
| `demo` | Like `dev`, plus the **demo auto-approver**: a separate service principal that decides new requests at a rate set with a slider in the portal (100% always approves, 0% always declines), so one presenter can run the flow. Owner group `jit-access-owners`. Setup: [RUNBOOK.md](RUNBOOK.md#solo-presenter-demo-auto-approver) |
| `prod` | Production mode; `demo_mode=false`, no auto-approver |

## Demo script (about 5 min)

Full presenter runbook (cast, pre-flight, talk track, reset, troubleshooting): [`RUNBOOK.md`](RUNBOOK.md).

1. As a user with no window, query `citizen_cases`: **0 rows**. Open the portal link (from the table comment or the
   UC *Request access* redirect, which appears for principals outside the eligible group) with the product preselected.
2. Request 10 minutes (demo mode) with a justification. Show that the requester cannot approve their own request.
3. As an owner-group member, approve. The user's *My access* tab now shows rows.
4. Wait for expiry: the rows disappear at the timestamp, before the expiry job runs. The *Access review* tab shows PENDING -> ACTIVE -> EXPIRED.

## Evidence

- [`evidence/scenario-run.md`](evidence/scenario-run.md): 17/17 checks passed **through the deployed AppKit
  portal's HTTP API** as two real identities (operator user + test service principal), plus direct-warehouse
  checks of the UC layer. The scenario test redacts identities and URLs in this file by default.
- `src/portal/server/lifecycle.test.ts`: 7/7 unit tests of the rules, including a full two-person approval.
- [`evidence/setup.md`](evidence/setup.md): policies, grants, constraints, RFA destination, expiry runs, app status.
- [`evidence/demo-auto-approver.md`](evidence/demo-auto-approver.md): the demo auto-approver at 100% and 0%, through the deployed portal.
- [`evidence/lakebase-approval-store.md`](evidence/lakebase-approval-store.md): the deployed Lakebase store end to end
  (auto-approver at 100% and 0%, expiry, history trail, Postgres constraints and app-role privileges).
- [`evidence/lakebase-identity-probe.md`](evidence/lakebase-identity-probe.md): users need **no** access to the
  approval store; the guard reads it with the owner's rights.
- [`evidence/lakebase-rowfilter-test.md`](evidence/lakebase-rowfilter-test.md): first feasibility test (row filter,
  ABAC policy, no sync lag, fails closed).

## Why Lakebase for the approval store

The approval record is operational data: small, written row by row, read on every gated query. Lakebase
Postgres fits that, and registering it in Unity Catalog lets the guard read it **directly, with no sync**:

- **Exact and immediate:** an approval, extension or revoke written in Postgres applies on the next query.
- **Integrity in the database:** CHECK constraints (no self-approval, valid states, ACTIVE needs a window) and a
  partial unique index (one pending request per user and product) hold for every writer, not just the app.
- **Tamper-evident audit:** a `SECURITY DEFINER` trigger writes every insert, update and delete to
  `access_lifecycle_history`, with the Postgres role that made the change. The app role cannot read or write it.
- **Least privilege:** the app's Postgres role has SELECT, INSERT, UPDATE on two tables and nothing else (no
  DELETE). End users have no Postgres role and no grant on the store catalog; the guard and secure views read
  it with their owner's rights while `current_user()` stays the caller ([probe](evidence/lakebase-identity-probe.md)).
- **Fails closed:** if Lakebase is unreachable, gated queries error instead of returning data.

## Known limitations and deviations

- **Lakebase resources in bundles are Beta** (`postgres_projects`, `postgres_catalogs`). Gated queries depend on
  the Lakebase endpoint being available, and Lakebase catalogs need **serverless** compute (classic clusters fail
  closed). After scale-to-zero, the first gated query pays a cold start; `lakebase_suspend_timeout` controls it.
- **Jobs write to Postgres as their run-as identity.** In dev that is the deployer (project owner). For production,
  run the jobs as a platform service principal and give it a Postgres role with DML on the approval tables.
- **No Lakebase?** The Delta-based version (approval record in a Delta table with CDF, no Lakebase dependency)
  is kept as git tag [`v1-delta`](../../tree/v1-delta).
- **Upgrading from the Delta-based version** (before this change): the old `control.access_lifecycle` and
  `control.demo_settings` Delta tables are no longer used and are not migrated. Drop them once you no longer need
  their history.
- **No native TTL in Unity Catalog.** This is a build-on-top pattern. Access is gated at the **row** level: the
  standing SELECT grant stays in place, and outside a window queries return 0 rows rather than `PERMISSION_DENIED`.
  Table metadata stays visible (BROWSE-like). Where a privilege-level revoke is mandated, use time-bound group
  membership instead (for example Entra PIM for Groups, or the Account Groups API driven by a job).
- **Request for Access entry point:** UC only shows *Request access* when a privilege is missing. Members of
  the eligible group already hold SELECT, so they reach the portal by link. The RFA redirect serves everyone
  else.
- **Data copied during a window survives the window** (CTAS, downloads, exports). Pair with no `CREATE TABLE` on
  shared schemas for gated users, and with download and export controls. The same applies to any approach.
- **ABAC DENY policies are Beta** and must be enabled per metastore. The setup step is optional, and the run
  succeeds without it. Check 4 shows the owner lacking MANAGE; no control run without DENY was made, so the
  attribution to DENY is inferred.
- **The guard covers tables only.** Volumes and models need their own controls.
- **The control plane must live in an isolated catalog.** A catalog that grants broad MANAGE or MODIFY lets users
  forge approvals. Hence the dedicated catalog.
- **Approver check** uses `is_account_group_member(owner_group) OR is_member(owner_group)` under the user's token.
  The default `owner_group` is the workspace `admins` group. In production, use the data-owner account group.
- **Second approver** (two-person rule): end to end, the test covers "first approval does not grant" and "same
  approver rejected". The completing second approval is covered by unit tests.
- **Notifications:** `v_expiring_soon` is the feed for renewal reminders. Wiring a SQL alert or webhook is left as a next step.
- **Transformation:** the data product is generated directly by a Lakeflow job task. There is no medallion
  pipeline, because the story is about access control rather than transformation.
- **npm registry:** `src/portal/.npmrc` sets no registry override, so the Databricks Apps build uses its default
  registry with versions pinned by `package-lock.json`. If your organisation mandates a mirror, it must be
  reachable from the Apps build environment.
- **SQL type quirk:** booleans can arrive as the strings `'true'`/`'false'` despite the generated types; the client
  coerces them explicitly (`isTrue`).
- **Caching disabled:** AppKit caches analytics results for 1 hour by default. Access state changes by the second,
  so `createApp({ cache: { enabled: false } })` is set deliberately.
- **Generated file:** `src/portal/appkit.plugins.json` is regenerated by `appkit plugin sync` on every build.

## Disclaimer

Reference implementation for illustration. Not an official Databricks product; review and test before use.
