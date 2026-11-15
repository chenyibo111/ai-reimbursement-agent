package auth

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/store"
)

type memorySessionRepository struct {
	rows map[string]store.SessionRecord
}

func (repository *memorySessionRepository) PutSession(_ context.Context, record store.SessionRecord) error {
	repository.rows[record.IDHash] = record
	return nil
}
func (repository *memorySessionRepository) FindSession(_ context.Context, hash string) (*store.SessionRecord, error) {
	row, ok := repository.rows[hash]
	if !ok {
		return nil, nil
	}
	return &row, nil
}
func (repository *memorySessionRepository) DeleteSessionsBySID(_ context.Context, sid string) error {
	for hash, row := range repository.rows {
		if row.SID == sid {
			delete(repository.rows, hash)
		}
	}
	return nil
}

type statusFunc func(context.Context, string) (bool, error)

func (fn statusFunc) IsActive(ctx context.Context, sid string) (bool, error) { return fn(ctx, sid) }
func (fn statusFunc) RecordActivity(ctx context.Context, sid string) (bool, error) {
	return fn(ctx, sid)
}

func TestSessionActivityRequiresActiveCookieAndSID(t *testing.T) {
	now := time.Date(2026, 11, 14, 1, 0, 0, 0, time.UTC)
	repository := &memorySessionRepository{rows: make(map[string]store.SessionRecord)}
	status := "active"
	service, err := NewSessionService(repository, statusFunc(func(context.Context, string) (bool, error) { return status == "active", nil }), strings.Repeat("s", 32), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	cookie, err := service.Create(context.Background(), "employee-1", "sid-1", "signed-id-token", now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if err := service.RecordActivity(context.Background(), cookie); err != nil {
		t.Fatalf("active activity: %v", err)
	}
	status = "expired"
	if err := service.RecordActivity(context.Background(), cookie); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expired sid renewed: %v", err)
	}
	if err := service.RecordActivity(context.Background(), "invalid"); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("invalid cookie renewed: %v", err)
	}
}

func TestSessionStoresOnlyHashedCookieAndEncryptedIDToken(t *testing.T) {
	now := time.Date(2026, 11, 3, 1, 0, 0, 0, time.UTC)
	repository := &memorySessionRepository{rows: make(map[string]store.SessionRecord)}
	service, err := NewSessionService(repository, statusFunc(func(_ context.Context, sid string) (bool, error) {
		return sid == "sid-1", nil
	}), strings.Repeat("s", 32), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	cookie, err := service.Create(context.Background(), "employee-1", "sid-1", "signed-id-token", now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if cookie == "" || strings.Contains(cookie, "signed-id-token") || len(repository.rows) != 1 {
		t.Fatal("opaque cookie or persisted row missing")
	}
	for hash, row := range repository.rows {
		if hash == cookie || row.EncryptedIDToken == "signed-id-token" || strings.Contains(row.EncryptedIDToken, "signed-id-token") {
			t.Fatal("raw cookie or ID Token was persisted")
		}
	}
	active, err := service.Active(context.Background(), cookie)
	if err != nil || active.EmployeeID != "employee-1" || active.SID != "sid-1" || active.IDToken != "signed-id-token" {
		t.Fatalf("active session roundtrip failed: %+v, %v", active, err)
	}
}

func TestSessionRejectsTamperedAndExpiredCookie(t *testing.T) {
	now := time.Date(2026, 11, 3, 1, 0, 0, 0, time.UTC)
	repository := &memorySessionRepository{rows: make(map[string]store.SessionRecord)}
	service, err := NewSessionService(repository, statusFunc(func(context.Context, string) (bool, error) { return true, nil }), strings.Repeat("s", 32), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	cookie, err := service.Create(context.Background(), "employee-1", "sid-1", "signed-id-token", now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Active(context.Background(), cookie+"x"); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("tampered cookie should be unauthenticated: %v", err)
	}
	now = now.Add(2 * time.Minute)
	if _, err := service.Active(context.Background(), cookie); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expired cookie should be unauthenticated: %v", err)
	}
}

func TestSessionRevocationAndSSOOutageFailClosed(t *testing.T) {
	now := time.Date(2026, 11, 3, 1, 0, 0, 0, time.UTC)
	repository := &memorySessionRepository{rows: make(map[string]store.SessionRecord)}
	status := "active"
	service, err := NewSessionService(repository, statusFunc(func(context.Context, string) (bool, error) {
		switch status {
		case "revoked":
			return false, nil
		case "outage":
			return false, errors.New("SSO unavailable")
		default:
			return true, nil
		}
	}), strings.Repeat("s", 32), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	cookie, err := service.Create(context.Background(), "employee-1", "sid-1", "signed-id-token", now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	status = "revoked"
	if _, err := service.Active(context.Background(), cookie); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("revoked sid should be unauthenticated: %v", err)
	}
	status = "outage"
	if _, err := service.Active(context.Background(), cookie); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("SSO outage should be unavailable: %v", err)
	}
}
