# Databricks notebook source
# MAGIC %md
# MAGIC # Expiry job
# MAGIC Closes the lifecycle record for windows that have ended and times out stale requests, in the
# MAGIC Lakebase approval store. Enforcement does **not** depend on this job: the ABAC guard already returns
# MAGIC no rows once `expires_at` passes. This job keeps the system of record accurate for access reviews.
# MAGIC Idempotent: only rows still in ACTIVE / PENDING* are touched. Each run is logged to Delta.

# COMMAND ----------

import sys, os

sys.path.append(os.path.abspath("../common"))
from lakebase_conn import connect, quote_ident

dbutils.widgets.text("catalog", "jit_access")
dbutils.widgets.text("control_schema", "control")
dbutils.widgets.text("request_timeout_days", "7")
dbutils.widgets.text("lakebase_project", "jit-access")
dbutils.widgets.text("lakebase_schema", "jit_control")

ctl = f"`{dbutils.widgets.get('catalog')}`.`{dbutils.widgets.get('control_schema')}`"
timeout_days = int(dbutils.widgets.get("request_timeout_days"))
schema = quote_ident(dbutils.widgets.get("lakebase_schema"))

# COMMAND ----------

with connect(dbutils.widgets.get("lakebase_project")) as conn:
    expired = len(conn.execute(f"""
        UPDATE {schema}.access_lifecycle
        SET status = 'EXPIRED', closed_at = now(), closed_by = 'expiry-job'
        WHERE status = 'ACTIVE' AND expires_at <= now()
        RETURNING request_id""").fetchall())
    timed_out = len(conn.execute(f"""
        UPDATE {schema}.access_lifecycle
        SET status = 'TIMED_OUT', closed_at = now(), closed_by = 'expiry-job',
            decision_reason = 'No decision within ' || %s || ' days'
        WHERE status IN ('PENDING', 'PENDING_SECOND') AND requested_at < now() - make_interval(days => %s)
        RETURNING request_id""", (str(timeout_days), timeout_days)).fetchall())
    still_active = conn.execute(
        f"SELECT count(*) FROM {schema}.access_lifecycle WHERE status = 'ACTIVE'").fetchone()[0]

spark.sql(f"INSERT INTO {ctl}.expiry_runs VALUES (current_timestamp(), {expired}, {timed_out}, {still_active})")
print(f"expired={expired} timed_out={timed_out} still_active={still_active}")
