# Just-in-time data access on Databricks

Access to sensitive data is **granted only after approval** and **ends automatically at a set time**, enforced
by Unity Catalog at query time. Unity Catalog grants have no expiry, so this repo adds a thin layer: a standing
group grant, an approval record in Lakebase Postgres, and an ABAC row filter that checks the record against
`now()` on every query. All data is synthetic; everything workspace-specific is a bundle variable.

| | Manual grant + ticket | This pattern |
|---|---|---|
| Access after the end date | Until someone revokes | **0 s**: rows stop at `expires_at` |
| Self-approval | Policy only | Blocked by the app and a database constraint |
| Who can approve | Anyone who can GRANT | Owner-group members, checked as the signed-in user |
| Audit trail | Tickets and grant logs | Append-only history, written by a trigger |

## How it works

```
Portal (Databricks App, AppKit)
  request -> owner approves (no self-approval, optional second approver, tier max duration)
  identity and owner checks run as the user (OBO); writes run as the app service principal
        |
        v
Lakebase Postgres approval store  --registered in Unity Catalog (read-only catalog, no sync)-->
        |
        v
ABAC row filter on tagged tables -> guard UDF: TRUE only while now() is inside an approved window
Expiry job (every 15 min) closes records; enforcement does not depend on it
```

| Component | Default name |
|---|---|
| Data product (synthetic, 5,000 rows) | `jit_access.gated_data.citizen_cases`, tagged `jit_access_product=citizen_cases` |
| Standing grant | `account users`: SELECT on `gated_data` (group-level only) |
| Approval store | Lakebase project `jit-access`, schema `jit_control`; UC catalog `jit_access_store` |
| Catalogue | `jit_access.control.data_products` (owner group, tier, max duration) |
| Guard | UDF `control.tba_has_active_access` + ABAC policy `tba_guard_citizen_cases` |
| Bypass prevention | Optional ABAC DENY on `MANAGE ACCESS CONTROL` |
| Secure views | `v_my_access`, `v_review_queue`, `v_owner_access_review`, `v_owner_access_history` |
| Jobs / app | `<name_prefix>-setup`, `<name_prefix>-expiry`, `<name_prefix>-portal` |

Users get no Postgres role and no grant on the store: the guard and views read it with their owner's rights,
while `current_user()` stays the caller. The app's Postgres role has SELECT, INSERT, UPDATE on two tables only.

## Deploy

Prerequisites: Unity Catalog with ABAC, serverless compute and SQL warehouse, Databricks Apps, Lakebase, and a
CLI profile (`databricks auth login`).

```bash
databricks bundle deploy -p <profile>             # add -t demo for the solo-presenter auto-approver
databricks bundle run tba_setup -p <profile>
databricks bundle run access_portal -p <profile>
scripts/configure_rfa.sh <profile> jit_access.gated_data.citizen_cases [app-name]
```

| Target | Use |
|---|---|
| `dev` (default) | Development; needs two human identities to demo approval |
| `demo` | Adds a demo auto-approver (separate service principal, approval rate set by a slider); see [RUNBOOK.md](RUNBOOK.md) |
| `prod` | Production mode, no demo features |

Portal development: `cd src/portal && cp .env.example .env && npm ci && npm run dev`.

## Configuration

Override with `--var name=value` or `BUNDLE_VAR_<name>`.

| Variable | Default | Purpose |
|---|---|---|
| `name_prefix`, `portal_title` | `jit-access`, `Data Access Portal` | App and job names, portal title |
| `display_timezone` | empty (viewer's browser zone) | IANA time zone for timestamps in the portal |
| `catalog`, `control_schema`, `data_schema` | `jit_access`, `control`, `gated_data` | Dedicated catalog and schemas |
| `catalog_storage_root` | empty | Managed location for the catalog |
| `warehouse_id` | lookup `Serverless Starter Warehouse` | Warehouse for the app |
| `eligible_group`, `owner_group`, `standing_access_group` | `account users`, `admins`, `jit_standing_access` | Who holds the grant, who approves, who is exempt |
| `product_tag_key`, `product_tag_value` | `jit_access_product`, `citizen_cases` | Governed tag on gated tables |
| `lakebase_project`, `lakebase_catalog`, `lakebase_schema` | `jit-access`, `jit_access_store`, `jit_control` | Approval store |
| `lakebase_min_cu`, `lakebase_max_cu`, `lakebase_suspend_timeout` | `0.5`, `1`, `3600s` | Store compute and scale-to-zero delay |
| `demo_mode` | `true` (`false` in prod) | Minute-level durations |
| `demo_approver_scope` and keys | `jit-access-demo`, `client-id`, `client-secret` | Auto-approver credentials (`demo` target) |
| `expiry_cron`, `expiry_timezone`, `request_timeout_days` | every 15 min, `UTC`, `7` | Housekeeping |
| `synthetic_rows`, `synthetic_seed` | `5000`, `42` | Synthetic data |

## Evidence

- [`evidence/scenario-run.md`](evidence/scenario-run.md): 17/17 checks through the deployed portal as two identities.
- [`evidence/lakebase.md`](evidence/lakebase.md): Lakebase store end to end, identity probe, auto-approver.
- Unit tests: `cd src/portal && npm test`.

## Limitations

- **Row-level gating:** outside a window, queries return 0 rows rather than `PERMISSION_DENIED`, and table metadata
  stays visible. Where a privilege must disappear, use time-bound group membership instead.
- **Copies outlive the window** (CTAS, downloads, exports). Pair with export controls and no `CREATE TABLE` for
  gated users.
- **Tables only.** Volumes and models need their own controls.
- **Dedicated catalog required:** broad MANAGE or MODIFY on the catalog would let users forge approvals.
- **Lakebase dependency:** gated queries need the store reachable (they fail closed) and serverless compute; the
  first query after scale-to-zero is slower. A version without Lakebase is tagged [`v1-delta`](../../tree/v1-delta).
- **Job identity:** jobs write to Postgres as their run-as identity. In production, run them as a service
  principal with DML on the approval tables.
- **Request access button** only appears for principals without SELECT; eligible-group members use the portal link.
- **DENY policy** is optional; setup continues without it.

Reference implementation for illustration, not an official Databricks product. Review and test before use.
