# Just-in-time data access on Databricks

Access to a sensitive data product is **granted only after approval** and **ends automatically at a set time**.
Unity Catalog enforces it at query time. Unity Catalog has no native time-to-live on grants, so this repo shows
a thin, build-on-top pattern: a standing group grant, an approval record in Unity Catalog, and an ABAC row
filter policy that checks the record against the current time on every query.

Everything is synthetic and everything workspace-specific is a bundle variable (see [Configuration](#configuration)).

## Outcome

| KPI | Typical manual grant + ticket | With this pattern |
|---|---|---|
| Access still open after the approved end date | Until someone remembers to revoke | **0 s**: the guard stops returning rows at `expires_at` (evidence check 15) |
| Approvals that bypass the data owner | Possible (owners or admins grant directly) | Blocked: DENY `MANAGE ACCESS CONTROL` (Beta, check 4) |
| Self-approval | Policy only | Blocked in app logic **and** a Delta CHECK constraint (checks 5 and 6) |
| Who can approve | Whoever can run GRANT | Only owner-group members, checked as the signed-in user (check 8) |
| Audit evidence for access reviews | Spread across tickets and grants | One Delta table with change data feed (check 17) |

## How it works

```
User opens the access portal (Databricks App): directly, from the table comment, or via
   UC "Request access" (redirect URL destination; shown to principals that lack SELECT)
   -> owner-group member approves (no self-approval, optional two-person rule, tier max duration)
   -> portal server: identity + owner check run AS THE USER (OBO); the write runs as the app SP
      (users have no MODIFY on control.access_lifecycle)
   -> portal reads (*.obo.sql) hit caller-filtered secure views: own requests, owner-only queue and audit
   -> ABAC ROW FILTER policy on tables tagged <product_tag_key>=<id> calls
      control.tba_has_active_access(<id>): TRUE only while now() is inside an approved window
   -> expiry job (every 15 min by default) closes records ACTIVE -> EXPIRED; enforcement does not depend on it
```

| Component | Object (default names) |
|---|---|
| Isolated catalog | `jit_access` (users get only USE CATALOG) |
| Data product (synthetic) | `jit_access.gated_data.citizen_cases`, 5,000 rows, tagged `jit_access_product=citizen_cases` |
| Standing grant | `account users`: USE SCHEMA + SELECT on `gated_data` (group-level only, no per-user grants) |
| System of record | `jit_access.control.access_lifecycle` (CDF on, 5 CHECK constraints) + `data_products` |
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

## Demo script (about 5 min)

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
- [`evidence/lakebase-rowfilter-test.md`](evidence/lakebase-rowfilter-test.md): can the guard read approvals
  stored in Lakebase Postgres? (see below)

## Option: approval records in Lakebase

The approval record can live in **Lakebase Postgres** instead of a Delta table, with no sync step. Register the
Lakebase database in Unity Catalog (read-only Lakebase catalog) and let the guard UDF query it directly.
Tested on serverless SQL ([evidence](evidence/lakebase-rowfilter-test.md)):

- A UC SQL UDF can read the Lakebase catalog, and works as both a table row filter and an ABAC policy.
- A change in Postgres (expire, extend) takes effect on the very next query: no sync lag.
- If Lakebase is unreachable, the protected query **fails** (`FAILED_JDBC.CONNECTION`), so it fails closed.

Trade-offs: reads of gated tables now depend on Lakebase availability; registered Lakebase catalogs require
serverless compute (classic clusters fail closed); Postgres roles, not UC grants, control who can write
approvals, so lock them down; and whether end users need SELECT on the Lakebase catalog (definer vs invoker
rights) is not yet tested. The Delta table remains the default here.

## Known limitations and deviations

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
