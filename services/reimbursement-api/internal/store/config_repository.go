package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresConfigRepository struct{ pool *pgxpool.Pool }

func NewPostgresConfigRepository(pool *pgxpool.Pool) *PostgresConfigRepository {
	return &PostgresConfigRepository{pool: pool}
}

func (repository *PostgresConfigRepository) GetActive(ctx context.Context, configDomain string) (domain.ConfigSnapshot, error) {
	return scanConfigSnapshot(repository.pool.QueryRow(ctx, `SELECT v.domain,v.version,v.payload,v.published_at
		FROM reimbursement.config_active_versions a JOIN reimbursement.config_versions v ON v.domain=a.domain AND v.version=a.version WHERE a.domain=$1`, configDomain))
}

func (repository *PostgresConfigRepository) GetDraft(ctx context.Context, configDomain string) (domain.ConfigDraft, error) {
	return scanConfigDraft(repository.pool.QueryRow(ctx, `SELECT domain,revision,payload,author_id,note,COALESCE(approved_by,''),COALESCE(published_revision,0) FROM reimbursement.config_drafts WHERE domain=$1`, configDomain))
}

func (repository *PostgresConfigRepository) SaveDraft(ctx context.Context, actorID, configDomain string, expectedRevision int64, payload json.RawMessage, note string) (domain.ConfigDraft, error) {
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return domain.ConfigDraft{}, err
	}
	defer tx.Rollback(ctx)
	var row pgx.Row
	if expectedRevision == 0 {
		row = tx.QueryRow(ctx, `INSERT INTO reimbursement.config_drafts(domain,revision,payload,author_id,note)
			VALUES($1,1,$2,$3,$4) ON CONFLICT(domain) DO NOTHING
			RETURNING domain,revision,payload,author_id,note,COALESCE(approved_by,''),COALESCE(published_revision,0)`, configDomain, payload, actorID, note)
	} else {
		row = tx.QueryRow(ctx, `UPDATE reimbursement.config_drafts SET revision=revision+1,payload=$1,author_id=$2,note=$3,
			approved_revision=NULL,approved_by=NULL,updated_at=now() WHERE domain=$4 AND revision=$5
			RETURNING domain,revision,payload,author_id,note,COALESCE(approved_by,''),COALESCE(published_revision,0)`, payload, actorID, note, configDomain, expectedRevision)
	}
	draft, err := scanConfigDraft(row)
	if errors.Is(err, application.ErrConfigNotFound) {
		return domain.ConfigDraft{}, application.ErrConfigConflict
	}
	if err != nil {
		return domain.ConfigDraft{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO reimbursement.config_audit(domain,action,actor_id,draft_revision,note) VALUES($1,'DRAFT_SAVED',$2,$3,$4)`, configDomain, actorID, draft.Revision, note); err != nil {
		return domain.ConfigDraft{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.ConfigDraft{}, err
	}
	return draft, nil
}

func (repository *PostgresConfigRepository) ApproveDraft(ctx context.Context, approverID, configDomain string, revision int64) (domain.ConfigDraft, error) {
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return domain.ConfigDraft{}, err
	}
	defer tx.Rollback(ctx)
	draft, err := scanConfigDraft(tx.QueryRow(ctx, `UPDATE reimbursement.config_drafts SET approved_by=$1,approved_revision=$2,updated_at=now()
		WHERE domain=$3 AND revision=$2 AND author_id<>$1 RETURNING domain,revision,payload,author_id,note,COALESCE(approved_by,''),COALESCE(published_revision,0)`, approverID, revision, configDomain))
	if err == application.ErrConfigNotFound {
		current, getErr := repository.getDraftTx(ctx, tx, configDomain)
		if getErr == nil && current.Revision != revision {
			return domain.ConfigDraft{}, application.ErrConfigConflict
		}
		return domain.ConfigDraft{}, application.ErrConfigApproval
	}
	if err != nil {
		return domain.ConfigDraft{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO reimbursement.config_audit(domain,action,actor_id,draft_revision) VALUES($1,'DRAFT_APPROVED',$2,$3)`, configDomain, approverID, revision); err != nil {
		return domain.ConfigDraft{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.ConfigDraft{}, err
	}
	return draft, nil
}

func (repository *PostgresConfigRepository) PublishDraft(ctx context.Context, actorID, configDomain string, expectedRevision int64) (domain.ConfigSnapshot, error) {
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return domain.ConfigSnapshot{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockConfigDomain(ctx, tx, configDomain); err != nil {
		return domain.ConfigSnapshot{}, err
	}
	var payload []byte
	var revision, approvedRevision, publishedRevision *int64
	var authorID, approvedBy string
	err = tx.QueryRow(ctx, `SELECT revision,payload,author_id,approved_revision,COALESCE(approved_by,''),published_revision FROM reimbursement.config_drafts WHERE domain=$1 FOR UPDATE`, configDomain).Scan(&revision, &payload, &authorID, &approvedRevision, &approvedBy, &publishedRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ConfigSnapshot{}, application.ErrConfigNotFound
	}
	if err != nil {
		return domain.ConfigSnapshot{}, err
	}
	if *revision != expectedRevision {
		return domain.ConfigSnapshot{}, application.ErrConfigConflict
	}
	if publishedRevision != nil && *publishedRevision == expectedRevision {
		return domain.ConfigSnapshot{}, application.ErrConfigConflict
	}
	if requiresIndependentApproval(configDomain) && (approvedRevision == nil || *approvedRevision != expectedRevision || approvedBy == authorID) {
		return domain.ConfigSnapshot{}, application.ErrConfigApproval
	}
	var version int64
	if err = tx.QueryRow(ctx, `SELECT COALESCE(MAX(version),0)+1 FROM reimbursement.config_versions WHERE domain=$1`, configDomain).Scan(&version); err != nil {
		return domain.ConfigSnapshot{}, err
	}
	snapshot, err := scanConfigSnapshot(tx.QueryRow(ctx, `INSERT INTO reimbursement.config_versions(domain,version,payload,published_by) VALUES($1,$2,$3,$4)
		RETURNING domain,version,payload,published_at`, configDomain, version, payload, actorID))
	if err != nil {
		return domain.ConfigSnapshot{}, err
	}
	var previous int64
	if err = tx.QueryRow(ctx, `SELECT COALESCE((SELECT version FROM reimbursement.config_active_versions WHERE domain=$1),0)`, configDomain).Scan(&previous); err != nil {
		return domain.ConfigSnapshot{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO reimbursement.config_active_versions(domain,version) VALUES($1,$2)
		ON CONFLICT(domain) DO UPDATE SET version=EXCLUDED.version,updated_at=now()`, configDomain, version); err != nil {
		return domain.ConfigSnapshot{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO reimbursement.config_audit(domain,action,actor_id,version,previous_version,draft_revision)
		VALUES($1,'PUBLISHED',$2,$3,$4,$5)`, configDomain, actorID, version, previous, expectedRevision); err != nil {
		return domain.ConfigSnapshot{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE reimbursement.config_drafts SET published_revision=$2 WHERE domain=$1`, configDomain, expectedRevision); err != nil {
		return domain.ConfigSnapshot{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.ConfigSnapshot{}, err
	}
	return snapshot, nil
}

func (repository *PostgresConfigRepository) ActivateVersion(ctx context.Context, actorID, configDomain string, expectedActiveVersion, targetVersion int64, note string) (domain.ConfigSnapshot, error) {
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return domain.ConfigSnapshot{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockConfigDomain(ctx, tx, configDomain); err != nil {
		return domain.ConfigSnapshot{}, err
	}
	snapshot, err := scanConfigSnapshot(tx.QueryRow(ctx, `SELECT domain,version,payload,published_at FROM reimbursement.config_versions WHERE domain=$1 AND version=$2`, configDomain, targetVersion))
	if err != nil {
		return domain.ConfigSnapshot{}, err
	}
	var previous int64
	if err = tx.QueryRow(ctx, `SELECT COALESCE((SELECT version FROM reimbursement.config_active_versions WHERE domain=$1),0)`, configDomain).Scan(&previous); err != nil {
		return domain.ConfigSnapshot{}, err
	}
	if previous != expectedActiveVersion {
		return domain.ConfigSnapshot{}, application.ErrConfigConflict
	}
	if previous == targetVersion {
		return snapshot, nil
	}
	if _, err = tx.Exec(ctx, `INSERT INTO reimbursement.config_active_versions(domain,version) VALUES($1,$2)
		ON CONFLICT(domain) DO UPDATE SET version=EXCLUDED.version,updated_at=now()`, configDomain, targetVersion); err != nil {
		return domain.ConfigSnapshot{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO reimbursement.config_audit(domain,action,actor_id,version,previous_version,note)
		VALUES($1,'ACTIVATED',$2,$3,$4,$5)`, configDomain, actorID, targetVersion, previous, note); err != nil {
		return domain.ConfigSnapshot{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.ConfigSnapshot{}, err
	}
	return snapshot, nil
}

func (repository *PostgresConfigRepository) ListHistory(ctx context.Context, configDomain string) ([]domain.ConfigAuditEntry, error) {
	rows, err := repository.pool.Query(ctx, `SELECT action,actor_id,version,previous_version,draft_revision,note,created_at
		FROM reimbursement.config_audit WHERE domain=$1 ORDER BY id DESC`, configDomain)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []domain.ConfigAuditEntry{}
	for rows.Next() {
		var item domain.ConfigAuditEntry
		if err := rows.Scan(&item.Action, &item.ActorID, &item.Version, &item.Previous, &item.DraftRevision, &item.Note, &item.At); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (repository *PostgresConfigRepository) getDraftTx(ctx context.Context, tx pgx.Tx, configDomain string) (domain.ConfigDraft, error) {
	return scanConfigDraft(tx.QueryRow(ctx, `SELECT domain,revision,payload,author_id,note,COALESCE(approved_by,''),COALESCE(published_revision,0) FROM reimbursement.config_drafts WHERE domain=$1`, configDomain))
}

func scanConfigDraft(row pgx.Row) (domain.ConfigDraft, error) {
	var draft domain.ConfigDraft
	if err := row.Scan(&draft.Domain, &draft.Revision, &draft.Payload, &draft.AuthorID, &draft.Note, &draft.ApprovedBy, &draft.PublishedRevision); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ConfigDraft{}, application.ErrConfigNotFound
		}
		return domain.ConfigDraft{}, fmt.Errorf("scan config draft: %w", err)
	}
	return draft, nil
}

func scanConfigSnapshot(row pgx.Row) (domain.ConfigSnapshot, error) {
	var snapshot domain.ConfigSnapshot
	if err := row.Scan(&snapshot.Domain, &snapshot.Version, &snapshot.Payload, &snapshot.PublishedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ConfigSnapshot{}, application.ErrConfigNotFound
		}
		return domain.ConfigSnapshot{}, fmt.Errorf("scan config snapshot: %w", err)
	}
	return snapshot, nil
}

func lockConfigDomain(ctx context.Context, tx pgx.Tx, configDomain string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, configDomain)
	return err
}

func requiresIndependentApproval(configDomain string) bool {
	return configDomain == "receipt_review" || configDomain == "knowledge_runtime" || configDomain == "model_runtime"
}
