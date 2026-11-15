package application

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

type configDraftPublisherStub struct {
	ConfigRepository
	draft     domain.ConfigDraft
	published bool
}

type configVersionActivatorStub struct {
	ConfigRepository
	payload   json.RawMessage
	activated bool
}

func (stub *configVersionActivatorStub) GetVersion(context.Context, string, int64) (domain.ConfigSnapshot, error) {
	return domain.ConfigSnapshot{Payload: stub.payload}, nil
}
func (stub *configVersionActivatorStub) ActivateVersion(context.Context, string, string, int64, int64, string) (domain.ConfigSnapshot, error) {
	stub.activated = true
	return domain.ConfigSnapshot{}, nil
}

func (stub *configDraftPublisherStub) GetDraft(context.Context, string) (domain.ConfigDraft, error) {
	return stub.draft, nil
}
func (stub *configDraftPublisherStub) PublishDraft(context.Context, string, string, int64) (domain.ConfigSnapshot, error) {
	stub.published = true
	return domain.ConfigSnapshot{}, nil
}

func TestConfigServiceRejectsUnknownDomain(t *testing.T) {
	service := NewConfigService(nil)
	_, err := service.SaveDraft(context.Background(), "admin-1", "arbitrary", 0, json.RawMessage(`{"x":1}`), "test")
	if !errors.Is(err, ErrConfigDomain) {
		t.Fatalf("expected unknown domain, got %v", err)
	}
}

func TestConfigServiceRejectsUnregisteredDomainAndInvalidPayload(t *testing.T) {
	service := NewConfigService(nil)
	_, err := service.SaveDraft(context.Background(), "admin-1", "expense_catalog", 0, json.RawMessage(`{"categories":[]}`), "test")
	if !errors.Is(err, ErrConfigValidatorUnavailable) {
		t.Fatalf("expected unavailable validator, got %v", err)
	}
	service.RegisterValidator("expense_catalog", func(payload json.RawMessage) error {
		var value struct {
			Categories []string `json:"categories"`
		}
		if err := json.Unmarshal(payload, &value); err != nil || len(value.Categories) == 0 {
			return ErrConfigInvalid
		}
		return nil
	})
	_, err = service.SaveDraft(context.Background(), "admin-1", "expense_catalog", 0, json.RawMessage(`{"categories":[]}`), "test")
	if !errors.Is(err, ErrConfigInvalid) {
		t.Fatalf("expected invalid payload, got %v", err)
	}
}

func TestConfigServiceChecksPolicyReferencesBeforePublishing(t *testing.T) {
	payload, _ := json.Marshal(testExpenseCatalog())
	stub := &configDraftPublisherStub{draft: domain.ConfigDraft{Domain: "expense_catalog", Revision: 1, Payload: payload}}
	service := NewConfigService(stub)
	service.RegisterValidator("expense_catalog", ValidateExpenseCatalogPayload)
	service.RegisterPublishValidator("expense_catalog", func(context.Context, json.RawMessage) error { return ErrConfigInvalid })
	if _, err := service.PublishDraft(context.Background(), "admin-1", "expense_catalog", 1); !errors.Is(err, ErrConfigInvalid) || stub.published {
		t.Fatalf("invalid policy reference was published: %v", err)
	}
}

func TestConfigServiceChecksPolicyReferencesBeforeRollback(t *testing.T) {
	payload, _ := json.Marshal(testExpenseCatalog())
	stub := &configVersionActivatorStub{payload: payload}
	service := NewConfigService(stub)
	service.RegisterValidator("expense_catalog", ValidateExpenseCatalogPayload)
	service.RegisterPublishValidator("expense_catalog", func(context.Context, json.RawMessage) error { return ErrConfigInvalid })
	if _, err := service.ActivateVersion(context.Background(), "admin-1", "expense_catalog", 2, 1, "rollback"); !errors.Is(err, ErrConfigInvalid) || stub.activated {
		t.Fatalf("incompatible catalog rollback was activated: %v", err)
	}
}
