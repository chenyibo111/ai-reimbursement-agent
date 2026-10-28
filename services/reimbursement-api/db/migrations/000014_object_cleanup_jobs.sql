CREATE TABLE IF NOT EXISTS reimbursement.object_cleanup_jobs (
  object_key TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS object_cleanup_jobs_due_idx
  ON reimbursement.object_cleanup_jobs (available_at)
  WHERE completed_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON reimbursement.object_cleanup_jobs TO reimbursement_api;
