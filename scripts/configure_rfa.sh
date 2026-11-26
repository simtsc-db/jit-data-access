#!/usr/bin/env bash
# Point Unity Catalog "Request access" for a gated table at the Data Access Portal.
# Usage: scripts/configure_rfa.sh <profile> <catalog.schema.table> [app-name]
# app-name defaults to "<name_prefix>-portal" with the bundle default prefix (jit-access-portal).
# Run after `databricks bundle run access_portal` (the app URL must exist).
set -euo pipefail
PROFILE="$1"; TABLE="$2"; APP_NAME="${3:-jit-access-portal}"
APP_URL=$(databricks apps get "$APP_NAME" -p "$PROFILE" -o json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])')
databricks rfa update-access-request-destinations destinations -p "$PROFILE" -o json --json "{
  \"securable\": {\"full_name\": \"$TABLE\", \"type\": \"TABLE\"},
  \"destinations\": [{\"destination_type\": \"URL\", \"destination_id\": \"$APP_URL/?securable=$TABLE\"}]
}"
