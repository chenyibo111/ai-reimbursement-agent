package application

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

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
