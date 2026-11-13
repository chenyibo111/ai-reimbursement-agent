package application

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

const ReceiptTypeUnknown = "UNKNOWN"

type ClassificationSuggestion struct {
	ReceiptType     string
	ExpenseCategory string
	Purpose         string
	Evidence        string
	Confidence      string
	Version         string
}

type ReceiptClassifier interface {
	Classify(context.Context, OCRResult, ExpenseCatalog) (ClassificationSuggestion, error)
}

func AllowedReceiptCategories(policy *PolicyVersion) ([]string, error) {
	if policy == nil {
		return nil, nil
	}
	var allowed []string
	for _, rule := range policy.Rules {
		if rule.Type != "CATEGORY_ALLOWED" {
			continue
		}
		var config struct {
			Categories []string `json:"categories"`
		}
		if err := json.Unmarshal(rule.Config, &config); err != nil || len(config.Categories) == 0 {
			return nil, fmt.Errorf("invalid published category rule")
		}
		if allowed == nil {
			allowed = append([]string{}, config.Categories...)
			continue
		}
		set := map[string]bool{}
		for _, category := range config.Categories {
			set[category] = true
		}
		filtered := []string{}
		for _, category := range allowed {
			if set[category] {
				filtered = append(filtered, category)
			}
		}
		allowed = filtered
	}
	if allowed != nil && len(allowed) == 0 {
		return nil, fmt.Errorf("published category rules have no common category")
	}
	return allowed, nil
}

func ResolveClassification(receiptType, evidence, confidence, ocrText string, catalog ExpenseCatalog) ClassificationSuggestion {
	unknown := ClassificationSuggestion{ReceiptType: ReceiptTypeUnknown}
	receiptType = strings.ToUpper(strings.TrimSpace(receiptType))
	evidence = strings.TrimSpace(evidence)
	confidence = strings.ToUpper(strings.TrimSpace(confidence))
	if evidence == "" || len([]rune(evidence)) > 120 || !strings.Contains(ocrText, evidence) || (confidence != "HIGH" && confidence != "MEDIUM") {
		return unknown
	}
	for _, mapping := range catalog.Mappings {
		if mapping.ReceiptType != receiptType {
			continue
		}
		for _, category := range catalog.Categories {
			if category.Code == mapping.CategoryCode && category.Enabled {
				return ClassificationSuggestion{ReceiptType: receiptType, ExpenseCategory: category.Label, Purpose: mapping.PurposeTemplate, Evidence: evidence, Confidence: confidence, Version: "v1"}
			}
		}
		return ClassificationSuggestion{ReceiptType: receiptType, Evidence: evidence, Confidence: confidence, Version: "v1"}
	}
	return unknown
}
