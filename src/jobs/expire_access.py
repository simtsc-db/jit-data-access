# Databricks notebook source
# MAGIC %md
# MAGIC # Expiry job
# MAGIC Closes the lifecycle record for windows that have ended and times out stale requests.
# MAGIC Enforcement does **not** depend on this job: the ABAC guard already returns no rows once
# MAGIC `expires_at` passes. This job keeps the system of record accurate for access reviews.
# MAGIC Idempotent: only rows still in ACTIVE / PENDING* are touched.

# COMMAND ----------

dbutils.widgets.text("catalog", "jit_access")
dbutils.widgets.text("control_schema", "control")
dbutils.widgets.text("request_timeout_days", "7")

ctl = f"`{dbutils.widgets.get('catalog')}`.`{dbutils.widgets.get('control_schema')}`"
timeout_days = int(dbutils.widgets.get("request_timeout_days"))

# COMMAND ----------

expired = spark.sql(f"""
UPDATE {ctl}.access_lifecycle
SET status = 'EXPIRED', closed_at = current_timestamp(), closed_by = 'expiry-job'
WHERE status = 'ACTIVE' AND expires_at <= current_timestamp()
""").collect()[0]["num_affected_rows"]

timed_out = spark.sql(f"""
UPDATE {ctl}.access_lifecycle
SET status = 'TIMED_OUT', closed_at = current_timestamp(), closed_by = 'expiry-job',
    decision_reason = 'No decision within {timeout_days} days'
WHERE status IN ('PENDING', 'PENDING_SECOND')
  AND requested_at < current_timestamp() - INTERVAL {timeout_days} DAYS
""").collect()[0]["num_affected_rows"]

still_active = spark.sql(
    f"SELECT count(*) c FROM {ctl}.access_lifecycle WHERE status = 'ACTIVE'").collect()[0]["c"]

spark.sql(f"INSERT INTO {ctl}.expiry_runs VALUES (current_timestamp(), {expired}, {timed_out}, {still_active})")
print(f"expired={expired} timed_out={timed_out} still_active={still_active}")
