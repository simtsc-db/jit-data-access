# Databricks notebook source
# MAGIC %md
# MAGIC # Approval store (Lakebase Postgres)
# MAGIC Creates the system of record for time-bound access in Lakebase, idempotently:
# MAGIC
# MAGIC | Object | Purpose |
# MAGIC |---|---|
# MAGIC | `access_lifecycle` | One row per request: PENDING -> ACTIVE -> EXPIRED (or DENIED / REVOKED / TIMED_OUT) |
# MAGIC | CHECK constraints | Valid states, no self-approval, distinct approvers, ACTIVE needs a window, decision source |
# MAGIC | Partial unique index | At most one pending request per principal and product |
# MAGIC | `access_lifecycle_history` + trigger | Append-only audit trail of every insert / update / delete |
# MAGIC | `demo_settings` | Demo auto-approver rate |
# MAGIC | Grants | The portal's service principal gets SELECT / INSERT / UPDATE on the two tables, nothing else |
# MAGIC
# MAGIC Runs as the deployer (project owner), who owns every object. Unity Catalog reads these tables through the
# MAGIC registered Lakebase catalog with the owner's rights; end users get no Postgres role and no catalog grant.

# COMMAND ----------

import sys, os

sys.path.append(os.path.abspath("../common"))
from lakebase_conn import connect, quote_ident

for k, v in {"lakebase_project": "jit-access", "lakebase_schema": "jit_control", "app_sp_client_id": ""}.items():
    dbutils.widgets.text(k, v)

project = dbutils.widgets.get("lakebase_project")
schema = quote_ident(dbutils.widgets.get("lakebase_schema"))
app_sp = dbutils.widgets.get("app_sp_client_id").strip()

# COMMAND ----------

DDL = f"""
CREATE SCHEMA IF NOT EXISTS {schema};

CREATE TABLE IF NOT EXISTS {schema}.access_lifecycle (
  request_id       text PRIMARY KEY,
  principal        text NOT NULL,
  product_id       text NOT NULL,
  privilege        text NOT NULL,
  justification    text,
  duration_minutes integer NOT NULL CONSTRAINT positive_duration CHECK (duration_minutes > 0),
  status           text NOT NULL CONSTRAINT valid_status
                   CHECK (status IN ('PENDING','PENDING_SECOND','ACTIVE','DENIED','EXPIRED','REVOKED','TIMED_OUT')),
  requested_by     text NOT NULL,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  approver_1       text,
  approver_2       text,
  decided_at       timestamptz,
  decision_reason  text,
  decision_source  text CONSTRAINT valid_decision_source
                   CHECK (decision_source IS NULL OR decision_source IN ('HUMAN','DEMO_AUTO')),
  starts_at        timestamptz,
  expires_at       timestamptz,
  closed_at        timestamptz,
  closed_by        text,
  CONSTRAINT no_self_approval CHECK (coalesce(approver_1,'') NOT IN (principal, requested_by)
                                     AND coalesce(approver_2,'') NOT IN (principal, requested_by)),
  CONSTRAINT distinct_approvers CHECK (approver_2 IS NULL OR approver_2 <> approver_1),
  CONSTRAINT active_needs_window CHECK (status <> 'ACTIVE' OR (approver_1 IS NOT NULL AND starts_at IS NOT NULL
                                                               AND expires_at > starts_at))
);
COMMENT ON TABLE {schema}.access_lifecycle IS
  'System of record for approval-gated, time-bound access. Read by the Unity Catalog ABAC guard at query time.';

CREATE UNIQUE INDEX IF NOT EXISTS one_pending_request
  ON {schema}.access_lifecycle (principal, product_id) WHERE status IN ('PENDING','PENDING_SECOND');
CREATE INDEX IF NOT EXISTS lifecycle_guard_lookup
  ON {schema}.access_lifecycle (principal, product_id, status, expires_at);

CREATE TABLE IF NOT EXISTS {schema}.access_lifecycle_history (
  history_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  changed_at      timestamptz NOT NULL DEFAULT now(),
  change_type     text NOT NULL,
  request_id      text NOT NULL,
  status          text,
  approver_1      text,
  approver_2      text,
  decision_source text,
  closed_by       text,
  db_role         text NOT NULL,
  row_data        text NOT NULL
);
COMMENT ON TABLE {schema}.access_lifecycle_history IS
  'Append-only audit trail of access_lifecycle, written by a trigger (the app cannot write it directly)';

CREATE OR REPLACE FUNCTION {schema}.log_lifecycle_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  INSERT INTO {schema}.access_lifecycle_history
    (change_type, request_id, status, approver_1, approver_2, decision_source, closed_by, db_role, row_data)
  VALUES (TG_OP, r.request_id, r.status, r.approver_1, r.approver_2, r.decision_source, r.closed_by,
          session_user, to_jsonb(r)::text);
  RETURN NULL;
END $$;

CREATE OR REPLACE TRIGGER lifecycle_history
  AFTER INSERT OR UPDATE OR DELETE ON {schema}.access_lifecycle
  FOR EACH ROW EXECUTE FUNCTION {schema}.log_lifecycle_change();

CREATE TABLE IF NOT EXISTS {schema}.demo_settings (
  setting    text PRIMARY KEY,
  value      text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO {schema}.demo_settings (setting, value, updated_by)
VALUES ('auto_approve_pct', '100', 'setup') ON CONFLICT (setting) DO NOTHING;
"""

with connect(project) as conn:
    conn.execute(DDL)
    owner = conn.execute("SELECT current_user").fetchone()[0]
    print(f"approval store ready in {schema} (owner {owner})")

    if app_sp:
        role = quote_ident(app_sp)
        exists = conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (app_sp,)).fetchone()
        if not exists:
            raise RuntimeError(f"Postgres role for the app service principal {app_sp} does not exist yet; "
                               "deploy the bundle first: the app's postgres resource creates the role")
        conn.execute(f"""
            GRANT USAGE ON SCHEMA {schema} TO {role};
            GRANT SELECT, INSERT, UPDATE ON {schema}.access_lifecycle TO {role};
            GRANT SELECT, INSERT, UPDATE ON {schema}.demo_settings TO {role};
            REVOKE ALL ON {schema}.access_lifecycle_history FROM {role};
        """)
        print(f"granted DML on access_lifecycle and demo_settings to {app_sp}")

    counts = conn.execute(f"SELECT status, count(*) FROM {schema}.access_lifecycle GROUP BY 1 ORDER BY 1").fetchall()
    print("lifecycle rows by status:", counts or "none")
