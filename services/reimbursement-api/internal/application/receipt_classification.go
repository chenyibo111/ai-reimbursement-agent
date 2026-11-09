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
	Classify(context.Context, OCRResult, []string) (ClassificationSuggestion, error)
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

func ResolveClassification(receiptType, evidence, confidence, ocrText string, allowedCategories []string) ClassificationSuggestion {
	unknown := ClassificationSuggestion{ReceiptType: ReceiptTypeUnknown}
	receiptType = strings.ToUpper(strings.TrimSpace(receiptType))
	evidence = strings.TrimSpace(evidence)
	confidence = strings.ToUpper(strings.TrimSpace(confidence))
	if evidence == "" || len([]rune(evidence)) > 120 || !strings.Contains(ocrText, evidence) || (confidence != "HIGH" && confidence != "MEDIUM") {
		return unknown
	}
	type candidate struct {
		purpose    string
		categories []string
	}
	options := map[string]candidate{
		"TAXI":      {"市内出行打车费", []string{"市内交通费", "打车费", "交通费"}},
		"DINING":    {"餐饮费用", []string{"餐饮费", "餐费"}},
		"LODGING":   {"住宿费用", []string{"住宿费", "酒店住宿费"}},
		"TRANSPORT": {"交通出行费用", []string{"交通费", "差旅交通费", "火车票"}},
	}
	option, ok := options[receiptType]
	if !ok {
		return unknown
	}
	category := option.categories[0]
	if len(allowedCategories) > 0 {
		category = ""
		for _, candidate := range option.categories {
			for _, allowed := range allowedCategories {
				if candidate == strings.TrimSpace(allowed) {
					category = allowed
					break
				}
			}
			if category != "" {
				break
			}
		}
	}
	return ClassificationSuggestion{ReceiptType: receiptType, ExpenseCategory: category, Purpose: option.purpose, Evidence: evidence, Confidence: confidence, Version: "v1"}
}
