package application

import (
	"encoding/json"
	"testing"
)

func TestResolveClassificationUsesPublishedCategoryWhitelist(t *testing.T) {
	text := "滴滴出行 网约车运输服务"
	result := ResolveClassification("TAXI", "网约车运输服务", "HIGH", text, []string{"餐饮费"})
	if result.ReceiptType != "TAXI" || result.ExpenseCategory != "" || result.Purpose != "市内出行打车费" {
		t.Fatalf("unallowed category should remain blank: %+v", result)
	}
	defaultCategory := ResolveClassification("TAXI", "网约车运输服务", "MEDIUM", text, nil)
	if defaultCategory.ExpenseCategory != "市内交通费" {
		t.Fatalf("default category=%q", defaultCategory.ExpenseCategory)
	}
}

func TestAllowedReceiptCategoriesIntersectsPublishedRules(t *testing.T) {
	policy := &PolicyVersion{Rules: []PolicyRule{
		{Type: "CATEGORY_ALLOWED", Config: json.RawMessage(`{"categories":["市内交通费","餐饮费"]}`)},
		{Type: "CATEGORY_ALLOWED", Config: json.RawMessage(`{"categories":["餐饮费","住宿费"]}`)},
	}}
	categories, err := AllowedReceiptCategories(policy)
	if err != nil || len(categories) != 1 || categories[0] != "餐饮费" {
		t.Fatalf("categories=%v err=%v", categories, err)
	}
}
