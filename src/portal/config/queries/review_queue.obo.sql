-- Pending requests for products the caller owns (owner-group filter inside the secure view).
-- @param ctl STRING = jit_access.control
SELECT request_id, principal, requested_by, product_id, display_name, sensitivity_tier, owner_group,
       second_approver_required, duration_minutes, justification, status, approver_1, requested_at
FROM IDENTIFIER(:ctl || '.v_review_queue')
ORDER BY requested_at
LIMIT 100
