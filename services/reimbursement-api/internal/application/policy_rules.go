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
				Categories    []string `json:"categories"`
				CategoryCodes []string `json:"categoryCodes"`
			}
			if err := decodePolicyConfig(rule.Config, &config); err != nil || (len(config.Categories) == 0) == (len(config.CategoryCodes) == 0) {
				return fmt.Errorf("invalid allowed categories rule")
			}
			for _, category := range append(config.Categories, config.CategoryCodes...) {
				if strings.TrimSpace(category) == "" {
					return fmt.Errorf("empty allowed category")
				}
			}
		case "CATEGORY_REQUIRED_FIELD":
			var config struct {
				Category     string `json:"category"`
				CategoryCode string `json:"categoryCode"`
				Field        string `json:"field"`
			}
			if err := decodePolicyConfig(rule.Config, &config); err != nil || (strings.TrimSpace(config.Category) == "") == (strings.TrimSpace(config.CategoryCode) == "") || (config.Field != "participants" && config.Field != "projectCode") {
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

func EvaluatePolicyRules(version PolicyVersion, claim domain.Claim, itemGroups ...[]domain.ExpenseItem) ([]domain.ValidationIssue, error) {
	if err := ValidatePolicyVersion(version); err != nil {
		return nil, err
	}
	issues := make([]domain.ValidationIssue, 0)
	items := []domain.ExpenseItem{{ExpenseCategory: claim.ExpenseCategory, ProjectCode: claim.ProjectCode, Participants: claim.Participants}}
	if claim.ItemizationMode == domain.ClaimItemizationModeItemized {
		count := max(len(claim.SelectedExpenseCategories), len(claim.SelectedExpenseCategoryCodes))
		items = make([]domain.ExpenseItem, 0, count)
		for index := 0; index < count; index++ {
			item := domain.ExpenseItem{ProjectCode: claim.ProjectCode, Participants: claim.Participants}
			if index < len(claim.SelectedExpenseCategories) {
				item.ExpenseCategory = claim.SelectedExpenseCategories[index]
			}
			if index < len(claim.SelectedExpenseCategoryCodes) {
				item.CategoryCode = claim.SelectedExpenseCategoryCodes[index]
			}
			items = append(items, item)
		}
	}
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
				Categories    []string `json:"categories"`
				CategoryCodes []string `json:"categoryCodes"`
			}
			_ = json.Unmarshal(rule.Config, &config)
			if len(items) == 0 {
				issues = append(issues, domain.ValidationIssue{Code: "POLICY_" + rule.Code, Message: rule.Name + "：请填写允许的费用类别。", Blocking: rule.Severity == "BLOCKING"})
			}
			for _, item := range items {
				allowed := false
				values, actual := config.Categories, item.ExpenseCategory
				if len(config.CategoryCodes) > 0 {
					values, actual = config.CategoryCodes, item.CategoryCode
				}
				for _, category := range values {
					if strings.TrimSpace(category) == strings.TrimSpace(actual) && strings.TrimSpace(actual) != "" {
						allowed = true
						break
					}
				}
				if !allowed {
					issues = append(issues, domain.ValidationIssue{Code: "POLICY_" + rule.Code, Message: rule.Name + "：请填写允许的费用类别。", Blocking: rule.Severity == "BLOCKING", ItemID: item.ID, ReceiptID: item.ReceiptID})
				}
			}
		case "CATEGORY_REQUIRED_FIELD":
			var config struct {
				Category     string `json:"category"`
				CategoryCode string `json:"categoryCode"`
				Field        string `json:"field"`
			}
			_ = json.Unmarshal(rule.Config, &config)
			for _, item := range items {
				match := config.Category != "" && strings.TrimSpace(item.ExpenseCategory) == strings.TrimSpace(config.Category)
				if config.CategoryCode != "" {
					match = strings.TrimSpace(item.CategoryCode) == strings.TrimSpace(config.CategoryCode)
				}
				if match {
					itemViolation := false
					itemMessage := ""
					if config.Field == "projectCode" {
						itemViolation = strings.TrimSpace(item.ProjectCode) == ""
						itemMessage = rule.Name + "：请补充项目编码。"
					} else {
						itemViolation = len(item.Participants) == 0
						for _, participant := range item.Participants {
							if strings.TrimSpace(participant) == "" {
								itemViolation = true
							}
						}
						itemMessage = rule.Name + "：请补充同行人。"
					}
					if itemViolation {
						issues = append(issues, domain.ValidationIssue{Code: "POLICY_" + rule.Code, Message: itemMessage, Blocking: rule.Severity == "BLOCKING", ItemID: item.ID, ReceiptID: item.ReceiptID})
					}
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

type PolicyRuleService struct {
	repository PolicyRuleRepository
	catalog    *CachedExpenseCatalogReader
}

func NewPolicyRuleService(repository PolicyRuleRepository) *PolicyRuleService {
	return &PolicyRuleService{repository: repository}
}
func (service *PolicyRuleService) SetExpenseCatalogReader(reader *CachedExpenseCatalogReader) {
	service.catalog = reader
}
func (service *PolicyRuleService) Publish(actorID string, version PolicyVersion) error {
	if actorID == "" {
		return fmt.Errorf("invalid policy publish")
	}
	if err := ValidatePolicyVersion(version); err != nil {
		return err
	}
	for _, rule := range version.Rules {
		var codes []string
		switch rule.Type {
		case "CATEGORY_ALLOWED":
			var config struct {
				CategoryCodes []string `json:"categoryCodes"`
			}
			_ = json.Unmarshal(rule.Config, &config)
			codes = config.CategoryCodes
		case "CATEGORY_REQUIRED_FIELD":
			var config struct {
				CategoryCode string `json:"categoryCode"`
			}
			_ = json.Unmarshal(rule.Config, &config)
			if config.CategoryCode != "" {
				codes = []string{config.CategoryCode}
			}
		}
		if len(codes) == 0 {
			continue
		}
		if service.catalog == nil {
			return ErrConfigInvalid
		}
		catalog, _, err := service.catalog.LoadCurrent(context.Background())
		if err != nil {
			return err
		}
		for _, code := range codes {
			enabled := false
			for _, category := range catalog.Categories {
				if category.Code == code && category.Enabled {
					enabled = true
					break
				}
			}
			if !enabled {
				return fmt.Errorf("%w: policy references disabled or missing category code %s", ErrConfigInvalid, code)
			}
		}
	}
	if version.Rules == nil {
		version.Rules = []PolicyRule{}
	}
	return service.repository.Publish(context.Background(), actorID, version)
}
