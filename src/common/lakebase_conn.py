"""Connect to the Lakebase approval store as the current Databricks identity (job owner / run_as)."""
from __future__ import annotations

import psycopg
from databricks.sdk import WorkspaceClient


def connect(project: str, branch: str = "production", database: str = "databricks_postgres") -> psycopg.Connection:
    """Autocommit connection to the branch's read-write endpoint, using a short-lived OAuth credential."""
    w = WorkspaceClient()
    endpoints = list(w.postgres.list_endpoints(parent=f"projects/{project}/branches/{branch}"))
    rw = next((e for e in endpoints if "READ_WRITE" in str(e.status.endpoint_type)), endpoints[0])
    host = rw.status.hosts.host
    token = w.postgres.generate_database_credential(endpoint=rw.name).token
    user = w.current_user.me().user_name
    return psycopg.connect(host=host, dbname=database, user=user, password=token, sslmode="require", autocommit=True)


def quote_ident(name: str) -> str:
    """Double-quote a Postgres identifier (schema or role name from configuration)."""
    return '"' + name.replace('"', '""') + '"'
