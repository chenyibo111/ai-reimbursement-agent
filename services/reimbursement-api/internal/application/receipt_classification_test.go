package application

import "testing"

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
