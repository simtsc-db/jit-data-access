# Databricks notebook source
# MAGIC %md
# MAGIC # 02 -- Governance: control plane, ABAC time-bound guard, grants, DENY
# MAGIC
# MAGIC | Layer | Object |
# MAGIC |---|---|
# MAGIC | Record | `access_lifecycle` (Delta, CDF on, CHECK constraints incl. no self-approval) |
# MAGIC | Catalogue | `data_products` (owner group, tier, max duration) |
# MAGIC | Guard | `tba_has_active_access(product)` UDF + ABAC ROW FILTER policy on tagged tables |
# MAGIC | Grant | group-level `SELECT` on the data schema to the eligible group (group-only grant policy) |
# MAGIC | Bypass prevention | ABAC DENY `MANAGE ACCESS CONTROL` (Beta) on the data schema |
# MAGIC
# MAGIC Idempotent: safe to rerun.

# COMMAND ----------

for k, v in {
    "catalog": "jit_access",
    "control_schema": "control",
    "data_schema": "gated_data",
    "eligible_group": "account users",
    "standing_access_group": "jit_standing_access",
    "owner_group": "admins",
    "app_sp_client_id": "",
    "product_tag_key": "jit_access_product",
    "product_tag_value": "citizen_cases",
}.items():
    dbutils.widgets.text(k, v)

catalog = dbutils.widgets.get("catalog")
ctl = f"`{catalog}`.`{dbutils.widgets.get('control_schema')}`"
data = f"`{catalog}`.`{dbutils.widgets.get('data_schema')}`"
data_fullname = f"{catalog}.{dbutils.widgets.get('data_schema')}"
eligible_group = dbutils.widgets.get("eligible_group")
standing_group = dbutils.widgets.get("standing_access_group")
owner_group = dbutils.widgets.get("owner_group")
app_sp = dbutils.widgets.get("app_sp_client_id").strip()

PRODUCT_ID = "citizen_cases"
TAG_KEY = dbutils.widgets.get("product_tag_key")        # governed tag that marks a gated table
TAG_VALUE = dbutils.widgets.get("product_tag_value")    # usually the product id

from databricks.sdk import WorkspaceClient
w = WorkspaceClient()
me = w.current_user.me().user_name
results = []  # (step, outcome) for the run summary

def step(name, fn):
    try:
        fn()
        results.append((name, "OK"))
    except Exception as e:  # record and continue; summary fails the task at the end
        results.append((name, f"FAILED: {str(e)[:300]}"))

# COMMAND ----------
# MAGIC %md ## 1. Control tables

# COMMAND ----------

def create_control_tables():
    spark.sql(f"""
    CREATE TABLE IF NOT EXISTS {ctl}.data_products (
      product_id STRING NOT NULL COMMENT 'Data product key, also the governed tag value',
      display_name STRING,
      securable STRING COMMENT 'Fully qualified table name',
      owner_group STRING COMMENT 'Group whose members may approve requests',
      sensitivity_tier STRING COMMENT 'Official-Open | Sensitive-Normal | Sensitive-High',
      max_duration_days INT COMMENT 'Upper bound on any approved access window',
      second_approver_required BOOLEAN)
    COMMENT 'Catalogue of time-bound data products and their approval rules'
    """)
    spark.sql(f"""
    CREATE TABLE IF NOT EXISTS {ctl}.access_lifecycle (
      request_id STRING NOT NULL,
      principal STRING NOT NULL COMMENT 'User email or service principal application id that gets access',
      product_id STRING NOT NULL,
      privilege STRING NOT NULL,
      justification STRING,
      duration_minutes INT NOT NULL,
      status STRING NOT NULL,
      requested_by STRING NOT NULL,
      requested_at TIMESTAMP NOT NULL,
      approver_1 STRING,
      approver_2 STRING,
      decided_at TIMESTAMP,
      decision_reason STRING,
      starts_at TIMESTAMP,
      expires_at TIMESTAMP,
      closed_at TIMESTAMP,
      closed_by STRING)
    CLUSTER BY (principal, product_id)
    COMMENT 'System of record for approval-gated, time-bound access. Read by the ABAC guard at query time.'
    TBLPROPERTIES (delta.enableChangeDataFeed = true)
    """)
    spark.sql(f"""
    CREATE TABLE IF NOT EXISTS {ctl}.expiry_runs (
      run_at TIMESTAMP, expired INT, timed_out INT, still_active INT)
    COMMENT 'One row per expiry job run'
    """)
    existing = {r.key for r in spark.sql(f"SHOW TBLPROPERTIES {ctl}.access_lifecycle").collect()}
    constraints = {
        "valid_status": "status IN ('PENDING','PENDING_SECOND','ACTIVE','DENIED','EXPIRED','REVOKED','TIMED_OUT')",
        "no_self_approval": "coalesce(approver_1,'') NOT IN (principal, requested_by) "
                            "AND coalesce(approver_2,'') NOT IN (principal, requested_by)",
        "distinct_approvers": "approver_2 IS NULL OR approver_2 <> approver_1",
        "active_needs_window": "status <> 'ACTIVE' OR (approver_1 IS NOT NULL AND starts_at IS NOT NULL "
                               "AND expires_at > starts_at)",
        "positive_duration": "duration_minutes > 0",
    }
    for name, expr in constraints.items():
        if f"delta.constraints.{name}" not in existing:
            spark.sql(f"ALTER TABLE {ctl}.access_lifecycle ADD CONSTRAINT {name} CHECK ({expr})")

    spark.sql(f"""
    MERGE INTO {ctl}.data_products t
    USING (SELECT '{PRODUCT_ID}' product_id, 'Citizen support cases (synthetic)' display_name,
                  '{data_fullname}.citizen_cases' securable, '{owner_group}' owner_group,
                  'Sensitive-High' sensitivity_tier, 7 max_duration_days,
                  false second_approver_required) s
    ON t.product_id = s.product_id
    WHEN MATCHED THEN UPDATE SET *
    WHEN NOT MATCHED THEN INSERT *
    """)

step("control tables + constraints", create_control_tables)

# COMMAND ----------
# MAGIC %md ## 2. Review views

# COMMAND ----------

def create_views():
    spark.sql(f"""
    CREATE OR REPLACE VIEW {ctl}.v_active_access
    COMMENT 'Access windows open right now (time-evaluated, independent of the expiry job)' AS
    SELECT principal, product_id, privilege, approver_1, approver_2, starts_at, expires_at,
           round((unix_timestamp(expires_at) - unix_timestamp(current_timestamp())) / 3600, 1) AS hours_left
    FROM {ctl}.access_lifecycle
    WHERE status = 'ACTIVE' AND current_timestamp() BETWEEN starts_at AND expires_at
    """)
    spark.sql(f"""
    CREATE OR REPLACE VIEW {ctl}.v_expiring_soon
    COMMENT 'Active windows ending within 7 days: feed for renewal reminders (e.g. a SQL alert)' AS
    SELECT * FROM {ctl}.v_active_access WHERE expires_at < current_timestamp() + INTERVAL 7 DAYS
    """)
    spark.sql(f"""
    CREATE OR REPLACE VIEW {ctl}.v_access_review
    COMMENT 'Access review / audit: every request with its decision and lifecycle' AS
    SELECT l.*, p.sensitivity_tier, p.owner_group,
           CASE WHEN l.status = 'ACTIVE' AND l.expires_at < current_timestamp()
                THEN 'EXPIRED (pending job close)' ELSE l.status END AS effective_status
    FROM {ctl}.access_lifecycle l LEFT JOIN {ctl}.data_products p USING (product_id)
    """)
    # Caller-filtered secure views for the portal (queried on-behalf-of the signed-in user).
    # Users get SELECT on these views only, never on the base tables; filtering is done by UC.
    owner_pred = "(is_account_group_member(p.owner_group) OR is_member(p.owner_group))"
    spark.sql(f"""
    CREATE OR REPLACE VIEW {ctl}.v_my_access
    COMMENT 'Portal: the caller''s own requests and windows (filtered by current_user())' AS
    SELECT l.request_id, l.product_id, p.display_name, p.sensitivity_tier, l.privilege, l.duration_minutes,
           l.justification, l.requested_at, l.approver_1, l.approver_2, l.starts_at, l.expires_at,
           l.closed_at, l.decision_reason,
           CASE WHEN l.status = 'ACTIVE' AND l.expires_at <= current_timestamp() THEN 'EXPIRED'
                ELSE l.status END AS effective_status
    FROM {ctl}.access_lifecycle l JOIN {ctl}.data_products p USING (product_id)
    WHERE l.principal = current_user()
    """)
    spark.sql(f"""
    CREATE OR REPLACE VIEW {ctl}.v_review_queue
    COMMENT 'Portal: pending requests for products whose owner group includes the caller' AS
    SELECT l.request_id, l.principal, l.requested_by, l.product_id, p.display_name, p.sensitivity_tier,
           p.owner_group, p.second_approver_required, l.privilege, l.duration_minutes, l.justification,
           l.status, l.approver_1, l.requested_at
    FROM {ctl}.access_lifecycle l JOIN {ctl}.data_products p USING (product_id)
    WHERE l.status IN ('PENDING', 'PENDING_SECOND') AND {owner_pred}
    """)
    spark.sql(f"""
    CREATE OR REPLACE VIEW {ctl}.v_owner_access_review
    COMMENT 'Portal: full lifecycle of every request for products the caller owns (access reviews)' AS
    SELECT l.request_id, l.principal, l.product_id, p.sensitivity_tier, l.duration_minutes, l.status,
           CASE WHEN l.status = 'ACTIVE' AND l.expires_at <= current_timestamp() THEN 'EXPIRED (pending job close)'
                ELSE l.status END AS effective_status,
           l.approver_1, l.approver_2, l.requested_at, l.starts_at, l.expires_at, l.closed_at, l.closed_by,
           l.decision_reason
    FROM {ctl}.access_lifecycle l JOIN {ctl}.data_products p USING (product_id)
    WHERE {owner_pred}
    """)

step("review views", create_views)

# COMMAND ----------
# MAGIC %md ## 3. Governed tag + tag the data product

# COMMAND ----------

def governed_tag():
    try:
        tp = w.api_client.do("GET", f"/api/2.1/tag-policies/{TAG_KEY}")
        values = {v["name"] for v in tp.get("values", [])}
        if values and TAG_VALUE not in values:
            body = {"tag_key": TAG_KEY,
                    "values": [{"name": v} for v in sorted(values | {TAG_VALUE})]}
            w.api_client.do("PATCH", f"/api/2.1/tag-policies/{TAG_KEY}",
                            query={"update_mask": "values"}, body=body)
    except Exception as e:
        msg = str(e).lower()
        if not any(t in msg for t in ("not_found", "not found", "does not exist")):
            raise
        w.api_client.do("POST", "/api/2.1/tag-policies", body={
            "tag_key": TAG_KEY,
            "description": "Time-bound access: data product key used by the ABAC guard",
            "values": [{"name": TAG_VALUE}]})
    spark.sql(f"ALTER TABLE {data}.citizen_cases SET TAGS ('{TAG_KEY}' = '{TAG_VALUE}')")

step("governed tag + table tag", governed_tag)

# COMMAND ----------
# MAGIC %md ## 4. Guard UDF + ABAC row filter policy
# MAGIC The guard is evaluated by Unity Catalog on every query. Rows are returned only when an
# MAGIC ACTIVE, approved record exists for `current_user()` and `now()` is inside the window,
# MAGIC capped by the product's `max_duration_days`. Expiry is therefore exact to the second,
# MAGIC even if the expiry job is late or never runs.

# COMMAND ----------

def guard():
    spark.sql(f"""
    CREATE OR REPLACE FUNCTION {ctl}.tba_has_active_access(p_product STRING)
    RETURNS BOOLEAN
    COMMENT 'ABAC guard: TRUE only inside an approved, unexpired access window (or standing access group)'
    RETURN is_account_group_member('{standing_group}')
      OR EXISTS (
        SELECT 1
        FROM {ctl}.access_lifecycle l
        JOIN {ctl}.data_products p ON p.product_id = l.product_id
        WHERE l.product_id = p_product
          AND l.principal = current_user()
          AND l.status = 'ACTIVE'
          AND l.approver_1 IS NOT NULL
          AND (NOT p.second_approver_required OR l.approver_2 IS NOT NULL)
          AND current_timestamp() >= l.starts_at
          AND current_timestamp() <  l.expires_at
          AND l.expires_at <= l.starts_at + make_interval(0, 0, 0, p.max_duration_days, 0, 0, 0))
    """)
    import time
    policy_sql = f"""
    CREATE OR REPLACE POLICY tba_guard_{PRODUCT_ID}
    ON SCHEMA {data}
    COMMENT 'Time-bound access guard for data product {PRODUCT_ID}'
    ROW FILTER {ctl}.tba_has_active_access
    TO `{eligible_group}`
    FOR TABLES
    WHEN has_tag_value('{TAG_KEY}', '{TAG_VALUE}')
    USING COLUMNS ('{PRODUCT_ID}')
    """
    for attempt in range(10):  # a newly created governed tag takes a short while to propagate
        try:
            spark.sql(policy_sql)
            return
        except Exception as e:
            if "Unknown tag policy key" not in str(e) or attempt == 9:
                raise
            time.sleep(30)

step("guard UDF + ABAC row filter policy", guard)

# COMMAND ----------
# MAGIC %md ## 5. Grants (group-level only) and app service principal

# COMMAND ----------

def grants():
    stmts = [
        f"GRANT USE SCHEMA, SELECT ON SCHEMA {data} TO `{eligible_group}`",
        # Portal reads (OBO): secure views only; no access to the base control tables.
        f"GRANT USE SCHEMA ON SCHEMA {ctl} TO `{eligible_group}`",
        f"GRANT SELECT ON TABLE {ctl}.data_products TO `{eligible_group}`",  # non-sensitive catalogue
        f"GRANT SELECT ON TABLE {ctl}.v_my_access TO `{eligible_group}`",
        f"GRANT SELECT ON TABLE {ctl}.v_review_queue TO `{eligible_group}`",
        f"GRANT SELECT ON TABLE {ctl}.v_owner_access_review TO `{eligible_group}`",
    ]
    if app_sp:
        stmts += [
            f"GRANT USE SCHEMA ON SCHEMA {ctl} TO `{app_sp}`",
            f"GRANT SELECT, MODIFY ON TABLE {ctl}.access_lifecycle TO `{app_sp}`",
            f"GRANT SELECT ON TABLE {ctl}.data_products TO `{app_sp}`",
            f"GRANT SELECT ON TABLE {ctl}.v_access_review TO `{app_sp}`",
            f"GRANT SELECT ON TABLE {ctl}.v_active_access TO `{app_sp}`",
        ]
    for s in stmts:
        spark.sql(s)
    # USE CATALOG may already be granted; we may not own the catalog.
    try:
        spark.sql(f"GRANT USE CATALOG ON CATALOG `{catalog}` TO `{eligible_group}`")
        if app_sp:
            spark.sql(f"GRANT USE CATALOG ON CATALOG `{catalog}` TO `{app_sp}`")
    except Exception as e:
        print(f"USE CATALOG grant skipped (not catalog owner?): {str(e)[:200]}")

step("group-level grants + app SP grants", grants)

# COMMAND ----------
# MAGIC %md ## 6. DENY MANAGE ACCESS CONTROL (Beta)
# MAGIC Stops anyone (including table owners) from granting around the workflow on the data
# MAGIC schema. Exempt: the deployer (platform admin). Metastore admins are always exempt.

# COMMAND ----------

def deny_policy():
    name = "tba_deny_manage_access_data"
    body = {
        "name": name,
        "comment": "Time-bound access: only the platform can manage grants on gated data",
        "on_securable_type": "SCHEMA",
        "on_securable_fullname": data_fullname,
        "for_securable_type": "TABLE",
        "policy_type": "POLICY_TYPE_DENY",
        "to_principals": [eligible_group],
        "except_principals": [me],
        "deny": {"privileges": ["MANAGE_ACCESS_CONTROL"]},
    }
    path = f"/api/2.1/unity-catalog/policies/SCHEMA/{data_fullname}"
    existing = w.api_client.do("GET", path).get("policies", [])
    if any(p.get("name") == name for p in existing):
        w.api_client.do("PATCH", f"{path}/{name}",
                        query={"update_mask": "to_principals,except_principals,comment"}, body=body)
    else:
        w.api_client.do("POST", "/api/2.1/unity-catalog/policies", body=body)

try:
    deny_policy()
    results.append(("ABAC DENY policy (Beta)", "OK"))
except Exception as e:
    # Beta feature: absence must not break setup. Recorded as a known limitation.
    results.append(("ABAC DENY policy (Beta)", f"SKIPPED (optional): {str(e)[:200]}"))

# COMMAND ----------

summary = "\n".join(f"{name:40s} {outcome}" for name, outcome in results)
print(summary)
display(spark.sql(f"SELECT * FROM {ctl}.data_products"))
if any(o.startswith("FAILED") for _, o in results):
    raise RuntimeError("One or more governance steps failed:\n" + summary)
