-- Drop the unique (user_id, leave_type_id, effective_from) constraint
-- so same-date policy re-creation doesn't error; date-boxing is handled in app code.
ALTER TABLE employee_leave_policies DROP CONSTRAINT IF EXISTS employee_leave_policies_user_id_leave_type_id_effective_from_key;
