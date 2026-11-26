# Databricks notebook source
# MAGIC %md
# MAGIC # 01 -- Generate the synthetic data product
# MAGIC Creates `citizen_cases`, a synthetic, sensitive case-management table that stands in for a
# MAGIC "Sensitive-High" data product. Fully synthetic: no real national ID numbers, names or addresses.
# MAGIC Idempotent: the same seed reproduces the same rows (table is replaced).

# COMMAND ----------

dbutils.widgets.text("catalog", "jit_access")
dbutils.widgets.text("control_schema", "control")
dbutils.widgets.text("data_schema", "gated_data")
dbutils.widgets.text("catalog_storage_root", "")
dbutils.widgets.text("seed", "42")
dbutils.widgets.text("rows", "5000")

catalog = dbutils.widgets.get("catalog")
control_schema = dbutils.widgets.get("control_schema")
data_schema = dbutils.widgets.get("data_schema")
seed = int(dbutils.widgets.get("seed"))
rows = int(dbutils.widgets.get("rows"))

# COMMAND ----------

# Dedicated catalog: no inherited user privileges, so the control plane cannot be written by users.
storage_root = dbutils.widgets.get("catalog_storage_root").strip()
location = f" MANAGED LOCATION '{storage_root}'" if storage_root else ""
spark.sql(f"CREATE CATALOG IF NOT EXISTS `{catalog}`{location} "
          "COMMENT 'Time-bound access: isolated catalog, no broad user grants'")
spark.sql(f"CREATE SCHEMA IF NOT EXISTS `{catalog}`.`{control_schema}` "
          "COMMENT 'Time-bound access: control plane (lifecycle, guard, audit views)'")
spark.sql(f"CREATE SCHEMA IF NOT EXISTS `{catalog}`.`{data_schema}` "
          "COMMENT 'Time-bound access: data products gated by approval + expiry'")

# COMMAND ----------

from pyspark.sql import functions as F

agencies = ["Social Services", "Housing", "Pensions", "Health", "Immigration", "Revenue"]
case_types = ["Financial assistance", "Housing appeal", "Medical subsidy", "Eldercare support",
              "Employment support", "Tax relief"]
statuses = ["Open", "In review", "Escalated", "Closed"]

def pick(values, col):
    arr = F.array(*[F.lit(v) for v in values])
    return F.element_at(arr, (F.abs(F.hash(col, F.lit(seed))) % len(values) + 1).cast("int"))

df = (
    spark.range(rows).withColumnRenamed("id", "n")
    .withColumn("case_id", F.format_string("CASE-%07d", F.col("n") + 1))
    .withColumn("citizen_ref", F.format_string("SYN-%08X", F.abs(F.hash("n", F.lit(seed + 1)))))
    .withColumn("agency", pick(agencies, F.col("n")))
    .withColumn("case_type", pick(case_types, F.col("n") * 7))
    .withColumn("status", pick(statuses, F.col("n") * 13))
    .withColumn("household_income",
                (F.abs(F.hash("n", F.lit(seed + 2))) % 9000 + 800).cast("int"))
    .withColumn("opened_at",
                F.expr(f"timestamp'2026-01-01 00:00:00' + make_interval(0,0,0, cast(abs(hash(n, {seed}+3)) % 320 as int), cast(abs(hash(n, {seed}+4)) % 24 as int), 0, 0)"))
    .withColumn("case_officer", F.format_string("officer_%03d", F.abs(F.hash("n", F.lit(seed + 5))) % 120))
    .drop("n")
)

target = f"`{catalog}`.`{data_schema}`.citizen_cases"
(df.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(target))

spark.sql(f"COMMENT ON TABLE {target} IS "
          "'SYNTHETIC. Citizen social-support cases across agencies. Sensitive-High data product: "
          "access only via approved, time-bound request in the Data Access Portal.'")
for col, cmt in {
    "case_id": "Case identifier",
    "citizen_ref": "Synthetic pseudonymous citizen reference (not a national ID number)",
    "agency": "Owning agency",
    "case_type": "Support scheme / case category",
    "status": "Case workflow status",
    "household_income": "Declared monthly household income (synthetic, no currency)",
    "opened_at": "Case opened timestamp (SGT)",
    "case_officer": "Synthetic case officer handle",
}.items():
    spark.sql(f"ALTER TABLE {target} ALTER COLUMN {col} COMMENT '{cmt}'")

print(f"{target}: {spark.table(target).count()} rows")
