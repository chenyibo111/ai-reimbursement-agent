CREATE TABLE IF NOT EXISTS reimbursement.processed_events (
  event_id UUID NOT NULL,
  consumer_name TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer_name)
);

ALTER TABLE reimbursement.outbox_events
  ADD COLUMN IF NOT EXISTS lease_token UUID,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS outbox_events_ready_idx
  ON reimbursement.outbox_events (occurred_at)
  WHERE published_at IS NULL;

GRANT SELECT, INSERT ON reimbursement.processed_events TO reimbursement_api;
