package application

import (
	"encoding/json"
	"testing"
)

func TestResolveClassificationUsesConfiguredCategory(t *testing.T) {
	text := "滴滴出行 网约车运输服务"
	result := ResolveClassification("TAXI", "网约车运输服务", "HIGH", text, testExpenseCatalog())
	if result.ReceiptType != "TAXI" || result.ExpenseCategory != "市内交通费" || result.Purpose != "市内出行打车费" {
		t.Fatalf("configured category should remain available: %+v", result)
	}
	defaultCategory := ResolveClassification("TAXI", "网约车运输服务", "MEDIUM", text, testExpenseCatalog())
	if defaultCategory.ExpenseCategory != "市内交通费" {
		t.Fatalf("default category=%q", defaultCategory.ExpenseCategory)
	}
}

func TestResolveClassificationMapsEvidenceBackedOtherReceipts(t *testing.T) {
	text := "电子发票 项目名称 *水果*水果 *蔬菜*蔬菜"
	result := ResolveClassification("OTHER", "*水果*水果", "HIGH", text, testExpenseCatalog())
	if result.ReceiptType != "OTHER" || result.ExpenseCategory != "其他" || result.Purpose != "其他费用" {
		t.Fatalf("other receipt classification=%+v", result)
	}
	uncertain := ResolveClassification("OTHER", "*水果*水果", "LOW", text, testExpenseCatalog())
	if uncertain.ReceiptType != ReceiptTypeUnknown || uncertain.ExpenseCategory != "" || uncertain.Purpose != "" {
		t.Fatalf("low-confidence receipt should remain unknown: %+v", uncertain)
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
