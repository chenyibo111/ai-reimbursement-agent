package store

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type EmployeeIdentity struct {
	ID          string
	DisplayName string
	Role        string
	IsActive    bool
}

type SessionRecord struct {
	IDHash           string
	EmployeeID       string
	SID              string
	EncryptedIDToken string
	ExpiresAt        time.Time
}

type WebAuthRepository struct{ pool *pgxpool.Pool }

func NewWebAuthRepository(pool *pgxpool.Pool) *WebAuthRepository {
	return &WebAuthRepository{pool: pool}
}

func (repository *WebAuthRepository) ResolveEmployee(ctx context.Context, openID, displayName, role string) (EmployeeIdentity, error) {
	if strings.TrimSpace(openID) == "" || strings.TrimSpace(displayName) == "" || !validWebAuthRole(role) {
		return EmployeeIdentity{}, fmt.Errorf("invalid SSO employee identity")
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return EmployeeIdentity{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, openID); err != nil {
		return EmployeeIdentity{}, err
	}
	var publicID, goID string
	if err = tx.QueryRow(ctx, `SELECT id FROM public."Employee" WHERE "feishuUserId"=$1`, openID).Scan(&publicID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return EmployeeIdentity{}, err
	}
	if err = tx.QueryRow(ctx, `SELECT id FROM reimbursement.employees WHERE feishu_user_id=$1`, openID).Scan(&goID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return EmployeeIdentity{}, err
	}
	if publicID != "" && goID != "" && publicID != goID {
		return EmployeeIdentity{}, fmt.Errorf("SSO employee ID mismatch")
	}
	id := publicID
	if id == "" {
		id = goID
	}
	if id == "" {
		id, err = newWebAuthUUID()
		if err != nil {
			return EmployeeIdentity{}, err
		}
	}
	var savedPublicID string
	err = tx.QueryRow(ctx, `INSERT INTO public."Employee" (id,"displayName","feishuUserId") VALUES ($1,$2,$3)
		ON CONFLICT ("feishuUserId") DO UPDATE SET "displayName"=EXCLUDED."displayName" RETURNING id`, id, displayName, openID).Scan(&savedPublicID)
	if err != nil {
		return EmployeeIdentity{}, err
	}
	if goID != "" && savedPublicID != goID {
		return EmployeeIdentity{}, fmt.Errorf("SSO employee ID mismatch")
	}
	id = savedPublicID
	var savedGoID string
	err = tx.QueryRow(ctx, `INSERT INTO reimbursement.employees (id,display_name,feishu_user_id,role,is_active)
		VALUES ($1,$2,$3,$4,true)
		ON CONFLICT (feishu_user_id) DO UPDATE SET display_name=EXCLUDED.display_name,role=EXCLUDED.role,is_active=true
		RETURNING id`, id, displayName, openID, role).Scan(&savedGoID)
	if err != nil {
		return EmployeeIdentity{}, err
	}
	if savedGoID != id {
		return EmployeeIdentity{}, fmt.Errorf("SSO employee ID mismatch")
	}
	if err = tx.Commit(ctx); err != nil {
		return EmployeeIdentity{}, err
	}
	return EmployeeIdentity{ID: id, DisplayName: displayName, Role: role, IsActive: true}, nil
}

func (repository *WebAuthRepository) PutSession(ctx context.Context, record SessionRecord) error {
	_, err := repository.pool.Exec(ctx, `INSERT INTO reimbursement.sso_web_sessions (id_hash,employee_id,sid,encrypted_id_token,expires_at) VALUES ($1,$2,$3,$4,$5)`, record.IDHash, record.EmployeeID, record.SID, record.EncryptedIDToken, record.ExpiresAt)
	return err
}

func (repository *WebAuthRepository) FindSession(ctx context.Context, idHash string) (*SessionRecord, error) {
	var record SessionRecord
	err := repository.pool.QueryRow(ctx, `SELECT id_hash,employee_id,sid,encrypted_id_token,expires_at FROM reimbursement.sso_web_sessions WHERE id_hash=$1`, idHash).
		Scan(&record.IDHash, &record.EmployeeID, &record.SID, &record.EncryptedIDToken, &record.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func (repository *WebAuthRepository) DeleteSessionsBySID(ctx context.Context, sid string) error {
	_, err := repository.pool.Exec(ctx, `DELETE FROM reimbursement.sso_web_sessions WHERE sid=$1`, sid)
	return err
}

func validWebAuthRole(role string) bool {
	return role == "EMPLOYEE" || role == "FINANCE_REVIEWER" || role == "ADMIN"
}

func newWebAuthUUID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}
