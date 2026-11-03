package auth

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/store"
)

var ErrUnauthenticated = errors.New("unauthenticated")
var ErrUnavailable = errors.New("session unavailable")

type SessionRepository interface {
	PutSession(context.Context, store.SessionRecord) error
	FindSession(context.Context, string) (*store.SessionRecord, error)
	DeleteSessionsBySID(context.Context, string) error
}

type SIDStatus interface {
	IsActive(context.Context, string) (bool, error)
}

type ActiveSession struct {
	EmployeeID string
	SID        string
	IDToken    string
}

type SessionService struct {
	repository SessionRepository
	status     SIDStatus
	key        [32]byte
	now        func() time.Time
}

func NewSessionService(repository SessionRepository, status SIDStatus, secret string, now func() time.Time) (*SessionService, error) {
	if repository == nil || status == nil || len(secret) < 32 {
		return nil, fmt.Errorf("SSO session repository, status, and secret are required")
	}
	if now == nil {
		now = time.Now
	}
	key := sha256.Sum256([]byte("reimbursement-go-sso-id-token:\x00" + secret))
	return &SessionService{repository: repository, status: status, key: key, now: now}, nil
}

func (service *SessionService) Create(ctx context.Context, employeeID, sid, idToken string, expiresAt time.Time) (string, error) {
	if employeeID == "" || sid == "" || idToken == "" || !expiresAt.After(service.now()) {
		return "", fmt.Errorf("invalid SSO session")
	}
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	cookie := base64.RawURLEncoding.EncodeToString(bytes)
	encrypted, err := service.encrypt(idToken)
	if err != nil {
		return "", err
	}
	if err := service.repository.PutSession(ctx, store.SessionRecord{IDHash: hashSessionCookie(cookie), EmployeeID: employeeID, SID: sid, EncryptedIDToken: encrypted, ExpiresAt: expiresAt}); err != nil {
		return "", ErrUnavailable
	}
	return cookie, nil
}

func (service *SessionService) Active(ctx context.Context, cookie string) (ActiveSession, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(cookie)
	if err != nil || len(decoded) != 32 {
		return ActiveSession{}, ErrUnauthenticated
	}
	record, err := service.repository.FindSession(ctx, hashSessionCookie(cookie))
	if err != nil {
		return ActiveSession{}, ErrUnavailable
	}
	if record == nil || !record.ExpiresAt.After(service.now()) {
		return ActiveSession{}, ErrUnauthenticated
	}
	idToken, err := service.decrypt(record.EncryptedIDToken)
	if err != nil {
		return ActiveSession{}, ErrUnauthenticated
	}
	active, err := service.status.IsActive(ctx, record.SID)
	if err != nil {
		return ActiveSession{}, ErrUnavailable
	}
	if !active {
		return ActiveSession{}, ErrUnauthenticated
	}
	return ActiveSession{EmployeeID: record.EmployeeID, SID: record.SID, IDToken: idToken}, nil
}

func (service *SessionService) DeleteBySID(ctx context.Context, sid string) error {
	if sid == "" {
		return fmt.Errorf("missing SSO sid")
	}
	return service.repository.DeleteSessionsBySID(ctx, sid)
}

func (service *SessionService) encrypt(raw string) (string, error) {
	block, err := aes.NewCipher(service.key[:])
	if err != nil {
		return "", err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(aead.Seal(nonce, nonce, []byte(raw), nil)), nil
}

func (service *SessionService) decrypt(encoded string) (string, error) {
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(service.key[:])
	if err != nil {
		return "", err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil || len(data) < aead.NonceSize() {
		return "", ErrUnauthenticated
	}
	plain, err := aead.Open(nil, data[:aead.NonceSize()], data[aead.NonceSize():], nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func hashSessionCookie(cookie string) string {
	digest := sha256.Sum256([]byte(cookie))
	return hex.EncodeToString(digest[:])
}
