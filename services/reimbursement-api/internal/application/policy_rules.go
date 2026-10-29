package application

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

type PolicyStatus string

var ErrPolicyVersionExists = errors.New("policy version already exists")

const (
	PolicyStatusDraft     PolicyStatus = "DRAFT"
	PolicyStatusPublished PolicyStatus = "PUBLISHED"
	PolicyStatusArchived  PolicyStatus = "ARCHIVED"
)

type PolicyVersion struct {
	ID            string
	EffectiveDate string
	Status        PolicyStatus
	Rules         []PolicyRule
}

type PolicyRule struct {
	Code     string          `json:"code"`
	Name     string          `json:"name"`
	Type     string          `json:"type"`
	Severity string          `json:"severity"`
	Config   json.RawMessage `json:"config"`
}

func ValidatePolicyVersion(version PolicyVersion) error {
	if strings.TrimSpace(version.ID) == "" || strings.TrimSpace(version.EffectiveDate) == "" {
		return fmt.Errorf("policy version and effective date are required")
	}
	if version.ID == "baseline-v1" || len(version.ID) > 80 {
		return fmt.Errorf("invalid policy version identifier")
	}
	if _, err := time.Parse("2006-01-02", version.EffectiveDate); err != nil {
		return fmt.Errorf("invalid policy effective date: %w", err)
	}
	seen := make(map[string]bool)
	for _, rule := range version.Rules {
		if strings.TrimSpace(rule.Code) == "" || strings.TrimSpace(rule.Name) == "" || seen[rule.Code] {
			return fmt.Errorf("invalid or duplicate policy rule code/name")
		}
		seen[rule.Code] = true
		if rule.Severity != "BLOCKING" && rule.Severity != "WARNING" {
			return fmt.Errorf("invalid policy rule severity")
		}
		switch rule.Type {
		case "CLAIM_TOTAL_MAX":
			var config struct {
				MaxAmountCents int64 `json:"maxAmountCents"`
			}
			if err := decodePolicyConfig(rule.Config, &config); err != nil || config.MaxAmountCents <= 0 {
				return fmt.Errorf("invalid total limit rule")
			}
		case "CATEGORY_ALLOWED":
			var config struct {
				Categories []string `json:"categories"`
			}
			if err := decodePolicyConfig(rule.Config, &config); err != nil || len(config.Categories) == 0 {
				return fmt.Errorf("invalid allowed categories rule")
			}
			for _, category := range config.Categories {
				if strings.TrimSpace(category) == "" {
					return fmt.Errorf("empty allowed category")
				}
			}
		case "CATEGORY_REQUIRED_FIELD":
			var config struct {
				Category string `json:"category"`
				Field    string `json:"field"`
			}
			if err := decodePolicyConfig(rule.Config, &config); err != nil || strings.TrimSpace(config.Category) == "" || (config.Field != "participants" && config.Field != "projectCode") {
				return fmt.Errorf("invalid required field rule")
			}
		default:
			return fmt.Errorf("unsupported policy rule type: %s", rule.Type)
		}
	}
	return nil
}

func decodePolicyConfig(raw json.RawMessage, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("extra policy configuration data")
	}
	return nil
}

func EvaluatePolicyRules(version PolicyVersion, claim domain.Claim) ([]domain.ValidationIssue, error) {
	if err := ValidatePolicyVersion(version); err != nil {
		return nil, err
	}
	issues := make([]domain.ValidationIssue, 0)
	for _, rule := range version.Rules {
		violated := false
		message := ""
		switch rule.Type {
		case "CLAIM_TOTAL_MAX":
			var config struct {
				MaxAmountCents int64 `json:"maxAmountCents"`
			}
			_ = json.Unmarshal(rule.Config, &config)
			violated = claim.RequestedAmountCent != nil && *claim.RequestedAmountCent > config.MaxAmountCents
			message = rule.Name + "：申请报销总额超过上限。"
		case "CATEGORY_ALLOWED":
			var config struct {
				Categories []string `json:"categories"`
			}
			_ = json.Unmarshal(rule.Config, &config)
			violated = true
			for _, category := range config.Categories {
				if strings.TrimSpace(category) == strings.TrimSpace(claim.ExpenseCategory) && strings.TrimSpace(claim.ExpenseCategory) != "" {
					violated = false
					break
				}
			}
			message = rule.Name + "：请填写允许的费用类别。"
		case "CATEGORY_REQUIRED_FIELD":
			var config struct {
				Category string `json:"category"`
				Field    string `json:"field"`
			}
			_ = json.Unmarshal(rule.Config, &config)
			if strings.TrimSpace(claim.ExpenseCategory) == strings.TrimSpace(config.Category) {
				if config.Field == "projectCode" {
					violated = strings.TrimSpace(claim.ProjectCode) == ""
					message = rule.Name + "：请补充项目编码。"
				} else {
					violated = len(claim.Participants) == 0
					for _, participant := range claim.Participants {
						if strings.TrimSpace(participant) == "" {
							violated = true
						}
					}
					message = rule.Name + "：请补充同行人。"
				}
			}
		}
		if violated {
			issues = append(issues, domain.ValidationIssue{Code: "POLICY_" + rule.Code, Message: message, Blocking: rule.Severity == "BLOCKING"})
		}
	}
	return issues, nil
}

type MemoryPolicyRuleRepository struct{ Versions map[string]PolicyVersion }

func NewMemoryPolicyRuleRepository() *MemoryPolicyRuleRepository {
	return &MemoryPolicyRuleRepository{Versions: map[string]PolicyVersion{}}
}

type PolicyRuleRepository interface {
	Publish(context.Context, string, PolicyVersion) error
}

func (repository *MemoryPolicyRuleRepository) Publish(_ context.Context, _ string, version PolicyVersion) error {
	if _, exists := repository.Versions[version.ID]; exists {
		return ErrPolicyVersionExists
	}
	version.Status = PolicyStatusPublished
	repository.Versions[version.ID] = version
	return nil
}

type PolicyRuleService struct{ repository PolicyRuleRepository }

func NewPolicyRuleService(repository PolicyRuleRepository) *PolicyRuleService {
	return &PolicyRuleService{repository}
}
func (service *PolicyRuleService) Publish(actorID string, version PolicyVersion) error {
	if actorID == "" {
		return fmt.Errorf("invalid policy publish")
	}
	if err := ValidatePolicyVersion(version); err != nil {
		return err
	}
	if version.Rules == nil {
		version.Rules = []PolicyRule{}
	}
	return service.repository.Publish(context.Background(), actorID, version)
}
