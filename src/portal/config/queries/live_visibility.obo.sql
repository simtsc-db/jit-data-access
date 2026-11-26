-- What Unity Catalog returns to the caller right now (the ABAC time-bound guard is evaluated here).
-- @param securable STRING = jit_access.gated_data.citizen_cases
SELECT count(*) AS visible_rows, current_timestamp() AS checked_at
FROM IDENTIFIER(:securable)
