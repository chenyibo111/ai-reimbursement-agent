CREATE TABLE IF NOT EXISTS reimbursement.idempotency_records (
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER,
  response_body TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS reimbursement.outbox_events (
  event_id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  publish_attempts INTEGER NOT NULL DEFAULT 0,
  last_failure_code TEXT
);

CREATE INDEX IF NOT EXISTS outbox_events_unpublished_idx
  ON reimbursement.outbox_events (occurred_at)
  WHERE published_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON reimbursement.idempotency_records TO reimbursement_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON reimbursement.outbox_events TO reimbursement_api;
