package store

import (
	"context"
	"fmt"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresPolicyRuleRepository struct{ pool *pgxpool.Pool }
func NewPostgresPolicyRuleRepository(pool *pgxpool.Pool) *PostgresPolicyRuleRepository { return &PostgresPolicyRuleRepository{pool} }
func (repository *PostgresPolicyRuleRepository) Publish(ctx context.Context, actorID string, version application.PolicyVersion) error {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{}); if err != nil { return err }; defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `UPDATE reimbursement.policy_versions SET status='ARCHIVED' WHERE status='PUBLISHED'`); err != nil { return fmt.Errorf("archive policy: %w",err) }
	if _, err = tx.Exec(ctx, `INSERT INTO reimbursement.policy_versions (id,status,effective_date,published_by,published_at) VALUES ($1,'PUBLISHED',$2::date,$3,now()) ON CONFLICT (id) DO UPDATE SET status='PUBLISHED',effective_date=EXCLUDED.effective_date,published_by=EXCLUDED.published_by,published_at=EXCLUDED.published_at`, version.ID,version.EffectiveDate,actorID); err != nil{return fmt.Errorf("publish policy: %w",err)}
	return tx.Commit(ctx)
}

type PostgresReviewCaseRepository struct{ pool *pgxpool.Pool }
func NewPostgresReviewCaseRepository(pool *pgxpool.Pool) *PostgresReviewCaseRepository{return &PostgresReviewCaseRepository{pool}}
func(repository *PostgresReviewCaseRepository) Resolve(ctx context.Context,actorID,caseID,resolution string)error{tx,err:=repository.pool.BeginTx(ctx,pgx.TxOptions{});if err!=nil{return err};defer tx.Rollback(ctx); result,err:=tx.Exec(ctx,`UPDATE reimbursement.review_cases SET status='RESOLVED',resolution=$3,resolved_by=$2,resolved_at=now() WHERE id=$1 AND status IN ('OPEN','CLAIMED')`,caseID,actorID,resolution);if err!=nil{return err};if result.RowsAffected()!=1{return fmt.Errorf("review case unavailable")};if _,err=tx.Exec(ctx,`INSERT INTO reimbursement.review_case_audits (review_case_id,actor_id,action) VALUES ($1,$2,'REVIEW_CASE_RESOLVED')`,caseID,actorID);err!=nil{return err};return tx.Commit(ctx)}
