-- name: GetEmployeeByID :one
SELECT id, display_name, department, feishu_user_id, role, created_at
FROM reimbursement.employees
WHERE id = $1;
