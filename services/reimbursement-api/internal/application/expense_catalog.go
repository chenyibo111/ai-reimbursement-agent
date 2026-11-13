package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

type Category struct {
	Code      string   `json:"code"`
	Label     string   `json:"label"`
	Aliases   []string `json:"aliases,omitempty"`
	Enabled   bool     `json:"enabled"`
	SortOrder int      `json:"sortOrder"`
}

type ReceiptMapping struct {
	ReceiptType     string `json:"receiptType"`
	CategoryCode    string `json:"categoryCode"`
	PurposeTemplate string `json:"purposeTemplate"`
}

type ExpenseCatalog struct {
	Categories []Category       `json:"categories"`
	Mappings   []ReceiptMapping `json:"mappings"`
}

type ConfigIssue struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

var categoryCodePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
var mappedReceiptTypes = []string{"TAXI", "DINING", "LODGING", "TRANSPORT", "OTHER"}

func ValidateExpenseCatalog(catalog ExpenseCatalog) []ConfigIssue {
	issues := []ConfigIssue{}
	if len(catalog.Categories) == 0 || len(catalog.Categories) > 100 {
		issues = append(issues, ConfigIssue{"categories", "INVALID_COUNT", "费用类别数量无效"})
	}
	if len(catalog.Mappings) != len(mappedReceiptTypes) {
		issues = append(issues, ConfigIssue{"mappings", "INVALID_COUNT", "每种票据类型必须有一条映射"})
	}
	categoryByCode := map[string]Category{}
	labels := map[string]bool{}
	for index, category := range catalog.Categories {
		path := fmt.Sprintf("categories[%d]", index)
		if !categoryCodePattern.MatchString(category.Code) || categoryByCode[category.Code].Code != "" {
			issues = append(issues, ConfigIssue{path + ".code", "INVALID_CODE", "费用类别编码无效或重复"})
		}
		if strings.TrimSpace(category.Label) != category.Label || len([]rune(category.Label)) == 0 || len([]rune(category.Label)) > 100 || labels[category.Label] {
			issues = append(issues, ConfigIssue{path + ".label", "INVALID_LABEL", "费用类别名称无效或重复"})
		}
		for _, alias := range category.Aliases {
			if strings.TrimSpace(alias) != alias || len([]rune(alias)) == 0 || len([]rune(alias)) > 100 {
				issues = append(issues, ConfigIssue{path + ".aliases", "INVALID_ALIAS", "费用类别别名无效"})
			}
		}
		categoryByCode[category.Code] = category
		labels[category.Label] = true
	}
	allowedTypes := map[string]bool{}
	for _, receiptType := range mappedReceiptTypes {
		allowedTypes[receiptType] = true
	}
	seenTypes := map[string]bool{}
	for index, mapping := range catalog.Mappings {
		path := fmt.Sprintf("mappings[%d]", index)
		if !allowedTypes[mapping.ReceiptType] || seenTypes[mapping.ReceiptType] {
			issues = append(issues, ConfigIssue{path + ".receiptType", "INVALID_RECEIPT_TYPE", "票据类型无效或重复"})
		}
		seenTypes[mapping.ReceiptType] = true
		category, found := categoryByCode[mapping.CategoryCode]
		if !found || !category.Enabled {
			issues = append(issues, ConfigIssue{path + ".categoryCode", "INVALID_CATEGORY", "映射必须指向已启用的费用类别"})
		}
		purpose := strings.TrimSpace(mapping.PurposeTemplate)
		if purpose == "" || purpose != mapping.PurposeTemplate || len([]rune(purpose)) > 100 || strings.ContainsAny(purpose, "{}") {
			issues = append(issues, ConfigIssue{path + ".purposeTemplate", "INVALID_PURPOSE", "通用事由无效"})
		}
	}
	for _, receiptType := range mappedReceiptTypes {
		if !seenTypes[receiptType] {
			issues = append(issues, ConfigIssue{"mappings", "MISSING_RECEIPT_TYPE", "缺少 " + receiptType + " 的映射"})
		}
	}
	return issues
}

func ValidateExpenseCatalogPayload(payload json.RawMessage) error {
	var catalog ExpenseCatalog
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&catalog); err != nil {
		return fmt.Errorf("decode expense catalog: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return ErrConfigInvalid
	}
	if issues := ValidateExpenseCatalog(catalog); len(issues) > 0 {
		return fmt.Errorf("%w: %s %s", ErrConfigInvalid, issues[0].Path, issues[0].Message)
	}
	return nil
}

func ValidateExpenseCatalogPolicyReferences(ctx context.Context, payload json.RawMessage, policies ActivePolicyReader) error {
	policy, err := policies.LoadActivePolicy(ctx, time.Now())
	if err != nil {
		return fmt.Errorf("load active policy for catalog validation: %w", err)
	}
	if policy == nil {
		return nil
	}
	var catalog ExpenseCatalog
	if err := json.Unmarshal(payload, &catalog); err != nil {
		return err
	}
	for _, rule := range policy.Rules {
		var references []string
		switch rule.Type {
		case "CATEGORY_ALLOWED":
			var config struct {
				Categories    []string `json:"categories"`
				CategoryCodes []string `json:"categoryCodes"`
			}
			if err := decodePolicyConfig(rule.Config, &config); err != nil {
				return err
			}
			references = append(config.Categories, config.CategoryCodes...)
		case "CATEGORY_REQUIRED_FIELD":
			var config struct {
				Category     string `json:"category"`
				CategoryCode string `json:"categoryCode"`
				Field        string `json:"field"`
			}
			if err := decodePolicyConfig(rule.Config, &config); err != nil {
				return err
			}
			references = []string{config.Category, config.CategoryCode}
		}
		for _, reference := range references {
			if reference == "" {
				continue
			}
			if !catalogCategoryEnabled(catalog, reference) {
				return fmt.Errorf("%w: policy rule %s references disabled or missing category %s", ErrConfigInvalid, rule.Code, reference)
			}
		}
	}
	return nil
}

func catalogCategoryEnabled(catalog ExpenseCatalog, reference string) bool {
	for _, category := range catalog.Categories {
		if category.Code == reference || category.Label == reference {
			return category.Enabled
		}
	}
	return false
}

type ExpenseCatalogSnapshotReader interface {
	GetActive(context.Context, string) (domain.ConfigSnapshot, error)
}

type CachedExpenseCatalogReader struct {
	source  ExpenseCatalogSnapshotReader
	mu      sync.RWMutex
	catalog ExpenseCatalog
	version int64
}

func NewCachedExpenseCatalogReader(source ExpenseCatalogSnapshotReader) *CachedExpenseCatalogReader {
	return &CachedExpenseCatalogReader{source: source}
}

func (reader *CachedExpenseCatalogReader) LoadCurrent(ctx context.Context) (ExpenseCatalog, int64, error) {
	snapshot, err := reader.source.GetActive(ctx, "expense_catalog")
	if err != nil {
		return ExpenseCatalog{}, 0, err
	}
	var catalog ExpenseCatalog
	if err := json.Unmarshal(snapshot.Payload, &catalog); err != nil {
		return ExpenseCatalog{}, 0, err
	}
	if issues := ValidateExpenseCatalog(catalog); len(issues) > 0 {
		return ExpenseCatalog{}, 0, fmt.Errorf("invalid expense catalog snapshot: %s", issues[0].Message)
	}
	return catalog, snapshot.Version, nil
}

func (reader *CachedExpenseCatalogReader) Load(ctx context.Context) (ExpenseCatalog, int64, error) {
	snapshot, err := reader.source.GetActive(ctx, "expense_catalog")
	if err == nil {
		var catalog ExpenseCatalog
		if decodeErr := json.Unmarshal(snapshot.Payload, &catalog); decodeErr != nil {
			err = decodeErr
		} else if issues := ValidateExpenseCatalog(catalog); len(issues) > 0 {
			err = fmt.Errorf("invalid expense catalog snapshot: %s", issues[0].Message)
		} else {
			reader.mu.Lock()
			reader.catalog, reader.version = catalog, snapshot.Version
			reader.mu.Unlock()
			return catalog, snapshot.Version, nil
		}
	}
	reader.mu.RLock()
	defer reader.mu.RUnlock()
	if reader.version == 0 {
		return ExpenseCatalog{}, 0, fmt.Errorf("load expense catalog: %w", err)
	}
	log.Printf("WARNING: using last valid expense catalog snapshot v%d: %v", reader.version, err)
	return reader.catalog, reader.version, nil
}
