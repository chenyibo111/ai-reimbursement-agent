package application

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

var (
	ErrConfigDomain               = errors.New("unknown configuration domain")
	ErrConfigValidatorUnavailable = errors.New("configuration validator unavailable")
	ErrConfigInvalid              = errors.New("invalid configuration")
	ErrConfigNotFound             = errors.New("configuration not found")
	ErrConfigConflict             = errors.New("configuration revision conflict")
	ErrConfigApproval             = errors.New("configuration approval required")
)

var configDomains = map[string]bool{
	"expense_catalog": true, "form_options": true, "feature_rollout": true,
	"receipt_review": true, "notification_templates": true,
	"knowledge_runtime": true, "model_runtime": true,
}

type ConfigRepository interface {
	GetActive(context.Context, string) (domain.ConfigSnapshot, error)
	GetDraft(context.Context, string) (domain.ConfigDraft, error)
	SaveDraft(context.Context, string, string, int64, json.RawMessage, string) (domain.ConfigDraft, error)
	ApproveDraft(context.Context, string, string, int64) (domain.ConfigDraft, error)
	PublishDraft(context.Context, string, string, int64) (domain.ConfigSnapshot, error)
	ActivateVersion(context.Context, string, string, int64, int64, string) (domain.ConfigSnapshot, error)
	ListHistory(context.Context, string) ([]domain.ConfigAuditEntry, error)
}

type ConfigService struct {
	repository        ConfigRepository
	validators        map[string]func(json.RawMessage) error
	publishValidators map[string]func(context.Context, json.RawMessage) error
}

func NewConfigService(repository ConfigRepository) *ConfigService {
	return &ConfigService{repository: repository, validators: map[string]func(json.RawMessage) error{}, publishValidators: map[string]func(context.Context, json.RawMessage) error{}}
}

func (service *ConfigService) RegisterValidator(domain string, validate func(json.RawMessage) error) {
	if configDomains[domain] && validate != nil {
		service.validators[domain] = validate
	}
}

func (service *ConfigService) RegisterPublishValidator(domain string, validate func(context.Context, json.RawMessage) error) {
	if configDomains[domain] && validate != nil {
		service.publishValidators[domain] = validate
	}
}

func (service *ConfigService) checkDomain(domain string) error {
	if !configDomains[domain] {
		return ErrConfigDomain
	}
	if service.validators[domain] == nil {
		return ErrConfigValidatorUnavailable
	}
	return nil
}

func (service *ConfigService) SaveDraft(ctx context.Context, actorID, configDomain string, expectedRevision int64, payload json.RawMessage, note string) (domain.ConfigDraft, error) {
	if err := service.checkDomain(configDomain); err != nil {
		return domain.ConfigDraft{}, err
	}
	if strings.TrimSpace(actorID) == "" || expectedRevision < 0 || len(payload) == 0 || len(payload) > 64*1024 || !json.Valid(payload) {
		return domain.ConfigDraft{}, ErrConfigInvalid
	}
	if err := service.validators[configDomain](payload); err != nil {
		return domain.ConfigDraft{}, errors.Join(ErrConfigInvalid, err)
	}
	return service.repository.SaveDraft(ctx, actorID, configDomain, expectedRevision, payload, note)
}

func (service *ConfigService) GetActive(ctx context.Context, configDomain string) (domain.ConfigSnapshot, error) {
	if err := service.checkDomain(configDomain); err != nil {
		return domain.ConfigSnapshot{}, err
	}
	return service.repository.GetActive(ctx, configDomain)
}

func (service *ConfigService) GetDraft(ctx context.Context, configDomain string) (domain.ConfigDraft, error) {
	if err := service.checkDomain(configDomain); err != nil {
		return domain.ConfigDraft{}, err
	}
	return service.repository.GetDraft(ctx, configDomain)
}

func (service *ConfigService) PreviewDraft(ctx context.Context, configDomain string, revision int64) (domain.ConfigPreview, error) {
	draft, err := service.GetDraft(ctx, configDomain)
	if err != nil {
		return domain.ConfigPreview{}, err
	}
	if draft.Revision != revision {
		return domain.ConfigPreview{}, ErrConfigConflict
	}
	if err := service.validators[configDomain](draft.Payload); err != nil {
		return domain.ConfigPreview{}, errors.Join(ErrConfigInvalid, err)
	}
	if validate := service.publishValidators[configDomain]; validate != nil {
		if err := validate(ctx, draft.Payload); err != nil {
			return domain.ConfigPreview{}, errors.Join(ErrConfigInvalid, err)
		}
	}
	active, err := service.repository.GetActive(ctx, configDomain)
	if errors.Is(err, ErrConfigNotFound) {
		return domain.ConfigPreview{Draft: draft}, nil
	}
	if err != nil {
		return domain.ConfigPreview{}, err
	}
	return domain.ConfigPreview{Draft: draft, Active: &active}, nil
}

func (service *ConfigService) ApproveDraft(ctx context.Context, approverID, configDomain string, revision int64) (domain.ConfigDraft, error) {
	if err := service.checkDomain(configDomain); err != nil {
		return domain.ConfigDraft{}, err
	}
	if strings.TrimSpace(approverID) == "" || revision <= 0 {
		return domain.ConfigDraft{}, ErrConfigInvalid
	}
	return service.repository.ApproveDraft(ctx, approverID, configDomain, revision)
}

func (service *ConfigService) PublishDraft(ctx context.Context, actorID, configDomain string, revision int64) (domain.ConfigSnapshot, error) {
	draft, err := service.GetDraft(ctx, configDomain)
	if err != nil {
		return domain.ConfigSnapshot{}, err
	}
	if draft.Revision != revision {
		return domain.ConfigSnapshot{}, ErrConfigConflict
	}
	if strings.TrimSpace(actorID) == "" || revision <= 0 {
		return domain.ConfigSnapshot{}, ErrConfigInvalid
	}
	if err := service.validators[configDomain](draft.Payload); err != nil {
		return domain.ConfigSnapshot{}, errors.Join(ErrConfigInvalid, err)
	}
	if validate := service.publishValidators[configDomain]; validate != nil {
		if err := validate(ctx, draft.Payload); err != nil {
			return domain.ConfigSnapshot{}, errors.Join(ErrConfigInvalid, err)
		}
	}
	return service.repository.PublishDraft(ctx, actorID, configDomain, revision)
}

func (service *ConfigService) ActivateVersion(ctx context.Context, actorID, configDomain string, expectedActiveVersion, targetVersion int64, note string) (domain.ConfigSnapshot, error) {
	if err := service.checkDomain(configDomain); err != nil {
		return domain.ConfigSnapshot{}, err
	}
	if strings.TrimSpace(actorID) == "" || expectedActiveVersion < 0 || targetVersion <= 0 || strings.TrimSpace(note) == "" {
		return domain.ConfigSnapshot{}, ErrConfigInvalid
	}
	return service.repository.ActivateVersion(ctx, actorID, configDomain, expectedActiveVersion, targetVersion, note)
}

func (service *ConfigService) ListHistory(ctx context.Context, configDomain string) ([]domain.ConfigAuditEntry, error) {
	if err := service.checkDomain(configDomain); err != nil {
		return nil, err
	}
	return service.repository.ListHistory(ctx, configDomain)
}
