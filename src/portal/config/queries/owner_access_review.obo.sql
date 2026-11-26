-- Full lifecycle for products the caller owns: access-review / audit evidence.
-- @param ctl STRING = jit_access.control
SELECT request_id, principal, product_id, sensitivity_tier, duration_minutes, effective_status,
       approver_1, approver_2, requested_at, starts_at, expires_at, closed_at, closed_by, decision_reason, decision_source,
       coalesce(effective_status = 'ACTIVE' AND expires_at < current_timestamp() + INTERVAL 7 DAYS, false) AS expires_within_7d,
       current_timestamp() AS as_of
FROM IDENTIFIER(:ctl || '.v_owner_access_review')
ORDER BY requested_at DESC
LIMIT 200
