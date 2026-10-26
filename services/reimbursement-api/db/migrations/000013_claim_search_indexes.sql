-- Owned claim search keeps the employee predicate in every query and uses
-- stable (sort value, id) cursor ordering.
CREATE INDEX IF NOT EXISTS claims_owner_created_id_idx
  ON reimbursement.claims(owner_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS claims_owner_amount_id_idx
  ON reimbursement.claims(owner_id, requested_amount_cent, id);

CREATE INDEX IF NOT EXISTS claims_owner_status_created_id_idx
  ON reimbursement.claims(owner_id, status, created_at DESC, id);
