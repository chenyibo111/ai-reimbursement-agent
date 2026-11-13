CREATE TABLE IF NOT EXISTS reimbursement.config_drafts (
  domain TEXT PRIMARY KEY,
  revision BIGINT NOT NULL CHECK (revision > 0),
  payload JSONB NOT NULL,
  author_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  approved_revision BIGINT,
  approved_by TEXT,
  published_revision BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT config_drafts_approval_pair CHECK ((approved_revision IS NULL) = (approved_by IS NULL))
);

CREATE TABLE IF NOT EXISTS reimbursement.config_versions (
  domain TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version > 0),
  payload JSONB NOT NULL,
  published_by TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (domain, version)
);

CREATE TABLE IF NOT EXISTS reimbursement.config_active_versions (
  domain TEXT PRIMARY KEY,
  version BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (domain, version) REFERENCES reimbursement.config_versions (domain, version)
);

CREATE TABLE IF NOT EXISTS reimbursement.config_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('DRAFT_SAVED','DRAFT_APPROVED','PUBLISHED','ACTIVATED')),
  actor_id TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 0,
  previous_version BIGINT NOT NULL DEFAULT 0,
  draft_revision BIGINT NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS config_audit_domain_created_idx ON reimbursement.config_audit(domain, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION reimbursement.reject_config_version_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'published configuration versions are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER config_versions_immutable BEFORE UPDATE OR DELETE ON reimbursement.config_versions
  FOR EACH ROW EXECUTE FUNCTION reimbursement.reject_config_version_change();
