-- The caller's own requests and windows. Filtered by current_user() inside the secure view.
-- @param ctl STRING = jit_access.control
SELECT request_id, product_id, display_name, sensitivity_tier, duration_minutes, effective_status,
       requested_at, approver_1, approver_2, starts_at, expires_at, decision_reason, decision_source,
       CAST(greatest(0, unix_timestamp(expires_at) - unix_timestamp(current_timestamp())) AS INT) AS seconds_left
FROM IDENTIFIER(:ctl || '.v_my_access')
ORDER BY requested_at DESC
LIMIT 50
