"""End-to-end scenario test for Time-bound access, driven through the DEPLOYED Access Portal.

The portal (AppKit) is called over HTTPS as two real identities, so the test exercises exactly what users
get: the app's rules, its on-behalf-of reads, and Unity Catalog enforcement. A few checks go straight to
the warehouse to prove the Unity Catalog layer holds even if the app is bypassed.

Identities
  * operator: the CLI profile user (data owner; member of the owner group).
  * analyst:  a separate test service principal (OAuth M2M), holding only the group-level grant.

Usage (secret only via env, never on disk):
  export TBA_TEST_SP_CLIENT_ID=... TBA_TEST_SP_SECRET=...
  python scripts/scenario_test.py --profile <p> --app-name jit-access-portal \
      --warehouse-id <id> --expiry-job-id <id>
Writes evidence/scenario-run.md. Identities, the workspace host, the app URL and the profile name are
redacted in that file by default (pass --no-redact to keep them, e.g. for an internal audit copy).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from databricks.sdk import WorkspaceClient
from databricks.sdk.service.sql import StatementState

ap = argparse.ArgumentParser()
ap.add_argument("--profile", required=True)
ap.add_argument("--app-name", default="jit-access-portal")
ap.add_argument("--warehouse-id", required=True)
ap.add_argument("--expiry-job-id", type=int, required=True)
ap.add_argument("--catalog", default="jit_access")
ap.add_argument("--control-schema", default="control")
ap.add_argument("--data-schema", default="gated_data")
ap.add_argument("--window-minutes", type=int, default=3)
ap.add_argument("--table", default="citizen_cases", help="Gated table name inside the data schema")
ap.add_argument("--no-redact", action="store_true", help="Keep identities and URLs in the evidence file")
args = ap.parse_args()

CTL = f"{args.catalog}.{args.control_schema}"
TABLE = f"{args.catalog}.{args.data_schema}.{args.table}"

op_ws = WorkspaceClient(profile=args.profile)
an_ws = WorkspaceClient(host=op_ws.config.host, auth_type="oauth-m2m",
                        client_id=os.environ["TBA_TEST_SP_CLIENT_ID"],
                        client_secret=os.environ["TBA_TEST_SP_SECRET"])
APP_URL = op_ws.apps.get(args.app_name).url.rstrip("/")


class Identity:
    """One caller: talks to the portal over HTTPS and (for UC-layer checks) to the warehouse directly."""

    def __init__(self, ws: WorkspaceClient):
        self.ws = ws

    def _headers(self) -> dict:
        return {**self.ws.config.authenticate(), "Content-Type": "application/json"}

    def post(self, path: str, body: dict | None = None) -> tuple[int, dict]:
        r = requests.post(f"{APP_URL}{path}", headers=self._headers(), data=json.dumps(body or {}), timeout=120)
        try:
            return r.status_code, r.json()
        except ValueError:
            return r.status_code, {"error": r.text[:200]}

    def app_query(self, key: str, **params: str) -> list[dict]:
        """Runs a portal query file (config/queries/<key>.obo.sql) through the app, as this identity."""
        body = {"parameters": {k: {"__sql_type": "STRING", "value": v} for k, v in params.items()}}
        r = requests.post(f"{APP_URL}/api/analytics/query/{key}", headers=self._headers(),
                          data=json.dumps(body), stream=True, timeout=180)
        event = None
        for raw in r.iter_lines(decode_unicode=True):
            if raw.startswith("event:"):
                event = raw.split(":", 1)[1].strip()
            elif raw.startswith("data:") and event in ("result", "error"):
                payload = json.loads(raw.split(":", 1)[1])
                if event == "error":
                    raise RuntimeError(f"app query {key} failed: {payload}")
                return payload.get("data", [])
        raise RuntimeError(f"app query {key}: no result event (HTTP {r.status_code})")

    def sql(self, statement: str) -> list[dict]:
        """Direct warehouse access (bypassing the app) for Unity Catalog layer checks."""
        resp = self.ws.statement_execution.execute_statement(
            statement=statement, warehouse_id=args.warehouse_id, wait_timeout="30s")
        while resp.status.state in (StatementState.PENDING, StatementState.RUNNING):
            time.sleep(1)
            resp = self.ws.statement_execution.get_statement(resp.statement_id)
        if resp.status.state != StatementState.SUCCEEDED:
            err = resp.status.error
            raise RuntimeError(f"{err.error_code}: {err.message}" if err else str(resp.status.state))
        if not resp.result or not resp.result.data_array:
            return []
        cols = [c.name for c in resp.manifest.schema.columns]
        return [dict(zip(cols, row)) for row in resp.result.data_array]


op, an = Identity(op_ws), Identity(an_ws)
OPERATOR = op.app_query("whoami")[0]["me"]
ANALYST = an.app_query("whoami")[0]["me"]

log: list[str] = []
checks: list[tuple[str, bool, str]] = []


def note(msg: str) -> None:
    print(msg)
    log.append(f"- `{datetime.now(timezone.utc):%H:%M:%S} UTC` {msg}")


def check(name: str, ok: bool, detail: str) -> None:
    checks.append((name, ok, detail))
    note(f"{'PASS' if ok else 'FAIL'} -- {name}: {detail}")


def visible(who: Identity) -> int:
    return int(who.app_query("live_visibility", securable=TABLE)[0]["visible_rows"])


def sql_error(who: Identity, statement: str) -> str | None:
    try:
        who.sql(statement)
    except RuntimeError as e:
        return str(e).splitlines()[0][:170]
    return None


def lifecycle(rid: str) -> dict:
    return op.sql(f"SELECT status, approver_1, starts_at, expires_at, closed_by FROM {CTL}.access_lifecycle "
                  f"WHERE request_id = '{rid}'")[0]


def req(who: Identity, minutes: int, why: str) -> tuple[int, dict]:
    return who.post("/api/portal/requests",
                    {"productId": "citizen_cases", "durationMinutes": minutes, "justification": why})


note(f"portal = {APP_URL}; operator = `{OPERATOR}`, analyst = `{ANALYST}` (identities as seen by the app, OBO)")
op.sql(f"UPDATE {CTL}.access_lifecycle SET status = 'REVOKED', closed_by = 'scenario-reset', "
       f"closed_at = current_timestamp() WHERE principal IN ('{ANALYST}', '{OPERATOR}') "
       "AND status IN ('PENDING','PENDING_SECOND','ACTIVE')")

# --- Unity Catalog layer (direct warehouse, app bypassed) --------------------------------------------
check("no access before approval (via app)", visible(an) == 0, f"analyst sees {visible(an)} rows")
err = sql_error(an, f"INSERT INTO {CTL}.access_lifecycle (request_id, principal, product_id, privilege, "
                    "duration_minutes, status, requested_by, requested_at, approver_1, starts_at, expires_at) "
                    "VALUES ('forged', current_user(), 'citizen_cases', 'SELECT', 60, 'ACTIVE', 'x', now(), "
                    "'someone', now(), now() + INTERVAL 1 HOUR)")
check("analyst cannot forge an approval (direct SQL)", err is not None, err or "insert succeeded (BAD)")
err = sql_error(an, f"DROP POLICY tba_guard_citizen_cases ON SCHEMA {args.catalog}.{args.data_schema}")
check("analyst cannot drop the ABAC guard", err is not None, err or "dropped (BAD)")
probe = f"{args.catalog}.{args.data_schema}.owner_bypass_probe"
op.sql(f"CREATE OR REPLACE TABLE {probe} AS SELECT 1 AS x")
op.sql(f"ALTER TABLE {probe} OWNER TO `{ANALYST}`")
try:
    err = sql_error(an, f"GRANT SELECT ON TABLE {probe} TO `account users`")
    check("table owner cannot grant directly (DENY policy)", err is not None, err or "grant succeeded (BAD)")
finally:
    op.sql(f"DROP TABLE IF EXISTS {probe}")

# --- Portal rules (through the deployed app) ---------------------------------------------------------
code, body = req(op, 60, "Scenario test: self-approval attempt")
rid_self = body.get("requestId", "")
code2, body2 = op.post(f"/api/portal/requests/{rid_self}/approve")
check("self-approval rejected (app)", code2 == 403, f"HTTP {code2}: {body2.get('error')}")
err = sql_error(op, f"UPDATE {CTL}.access_lifecycle SET status='ACTIVE', approver_1=principal, starts_at=now(), "
                    f"expires_at=now() + INTERVAL 1 HOUR WHERE request_id = '{rid_self}'")
check("self-approval rejected (Delta CHECK constraint)", err is not None, err or "update succeeded (BAD)")
op.post(f"/api/portal/requests/{rid_self}/decline", {"reason": "test cleanup"})

code, body = req(an, 8 * 1440, "Scenario test: window above tier max")
check("duration above tier max rejected (app)", code == 400, f"HTTP {code}: {body.get('error')}")

op.sql(f"UPDATE {CTL}.data_products SET second_approver_required = true WHERE product_id = 'citizen_cases'")
try:
    code, body = req(an, 30, "Scenario test: two-person rule")
    rid2 = body.get("requestId", "")
    code, body = an.post(f"/api/portal/requests/{rid2}/approve")
    check("non-owner cannot approve (app)", code == 403, f"HTTP {code}: {body.get('error')}")
    code, body = op.post(f"/api/portal/requests/{rid2}/approve")
    check("first of two approvals does not grant", body.get("status") == "PENDING_SECOND" and visible(an) == 0,
          f"HTTP {code} status {body.get('status')}, analyst sees {visible(an)} rows")
    code, body = op.post(f"/api/portal/requests/{rid2}/approve")
    check("same approver cannot approve twice (app)", code == 403, f"HTTP {code}: {body.get('error')}")
    op.post(f"/api/portal/requests/{rid2}/decline", {"reason": "test cleanup"})
finally:
    op.sql(f"UPDATE {CTL}.data_products SET second_approver_required = false WHERE product_id = 'citizen_cases'")

# --- Privacy of portal reads (secure views, OBO) -----------------------------------------------------
queue_seen = len(an.app_query("review_queue", ctl=CTL))
review_seen = len(an.app_query("owner_access_review", ctl=CTL))
mine_ids = {r["request_id"] for r in an.app_query("my_access", ctl=CTL)}
check("non-owner sees no queue or audit rows", queue_seen == 0 and review_seen == 0,
      f"review_queue {queue_seen} rows, owner_access_review {review_seen} rows")
check("my_access returns only the caller's rows", len(mine_ids) > 0 and rid_self not in mine_ids,
      f"{len(mine_ids)} own rows; operator's request not visible")

# --- Main flow: approve a short window, read data, watch it end -------------------------------------
code, body = req(an, args.window_minutes, "Scenario test: case-load analysis for scheme review")
rid = body.get("requestId", "")
note(f"analyst submitted `{rid}` via the portal (HTTP {code}, {args.window_minutes} min window)")
code, body = op.post(f"/api/portal/requests/{rid}/approve")
row = lifecycle(rid)
note(f"operator approved via the portal (HTTP {code} {body.get('status')}); "
     f"window {row['starts_at']} -> {row['expires_at']}")
n_during = visible(an)
check("access inside the window (via app)", n_during > 0, f"analyst sees {n_during} rows")
check("other principals unaffected", visible(op) == 0, f"operator (no window) sees {visible(op)} rows")

expires = datetime.fromisoformat(row["expires_at"].replace("Z", "+00:00"))
wait = (expires - datetime.now(timezone.utc)).total_seconds() + 5
note(f"waiting {int(wait)} s for expiry; expiry job deliberately NOT run yet")
time.sleep(max(wait, 0))
n_after = visible(an)
status_before_job = lifecycle(rid)["status"]
check("access ends at expires_at without any job (via app)", n_after == 0,
      f"analyst sees {n_after} rows; lifecycle status still `{status_before_job}`")

run = op_ws.jobs.run_now_and_wait(job_id=args.expiry_job_id)
row = lifecycle(rid)
check("expiry job closes the record", row["status"] == "EXPIRED",
      f"job run {run.run_id} {run.state.result_state.value}; status `{row['status']}` by `{row['closed_by']}`")

hist = op.sql(f"SELECT _change_type, status, approver_1, closed_by, _commit_timestamp FROM "
              f"table_changes('{CTL}.access_lifecycle', 0) WHERE request_id = '{rid}' "
              "ORDER BY _commit_version, _change_type")
trail = [h for h in hist if h["_change_type"] in ("insert", "update_postimage")]
check("change data feed has the full lifecycle", [h["status"] for h in trail] == ["PENDING", "ACTIVE", "EXPIRED"],
      " -> ".join(h["status"] for h in trail))

passed = sum(ok for _, ok, _ in checks)


def redact(text: str) -> str:
    """Replace identities and workspace locators with placeholders so evidence can be shared."""
    if args.no_redact:
        return text
    host = (op_ws.config.host or "").rstrip("/")
    for value, placeholder in ((APP_URL, "<portal-url>"), (host, "<workspace-url>"),
                               (OPERATOR, "<operator>"), (ANALYST, "<analyst-sp>"),
                               (os.environ["TBA_TEST_SP_CLIENT_ID"], "<analyst-sp>")):
        if value:
            text = text.replace(value, placeholder)
    return text.replace(f"profile `{args.profile}`", "profile `<profile>`")


out = Path(__file__).resolve().parents[1] / "evidence" / "scenario-run.md"
out.write_text(redact("\n".join([
    "# Scenario run: approval-gated, time-bound access (through the deployed AppKit portal)",
    "",
    f"Run: {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC, profile `{args.profile}`, portal `{APP_URL}`, "
    f"table `{TABLE}` (synthetic). Requests and approvals go through the portal's HTTP API as two real "
    "identities. UC-layer checks also go straight to the warehouse.",
    "",
    f"**Result: {passed}/{len(checks)} checks passed.**",
    "",
    "| # | Check | Result | Detail |",
    "|---|---|---|---|",
    *[f"| {i} | {name} | {'PASS' if ok else 'FAIL'} | {detail.replace('|', '/')} |"
      for i, (name, ok, detail) in enumerate(checks, 1)],
    "",
    "## Timeline",
    *log,
    "",
    "## Lifecycle record (change data feed)",
    "| change | status | approver_1 | closed_by | commit |",
    "|---|---|---|---|---|",
    *[f"| {h['_change_type']} | {h['status']} | {h['approver_1']} | {h['closed_by']} | {h['_commit_timestamp']} |"
      for h in trail],
    "",
])))
print(f"\n{passed}/{len(checks)} checks passed -> {out}")
sys.exit(0 if passed == len(checks) else 1)
