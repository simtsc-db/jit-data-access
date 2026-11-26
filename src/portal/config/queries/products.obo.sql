-- Data product catalogue (non-sensitive). Runs on-behalf-of the user.
-- @param ctl STRING = jit_access.control
SELECT product_id, display_name, securable, owner_group, sensitivity_tier,
       max_duration_days, second_approver_required
FROM IDENTIFIER(:ctl || '.data_products')
ORDER BY product_id
