package domain

import "testing"

func TestExpenseItemSuggestionDoesNotReplaceManualFields(t *testing.T) {
	amount := int64(3800)
	item := ExpenseItem{
		ReceiptID: "receipt-1", ExpenseCategory: "市内交通费", CategorySource: FieldSourceManual,
		Purpose: "客户拜访打车", PurposeSource: FieldSourceManual,
		AmountCent: &amount, AmountSource: FieldSourceManual,
	}
	newAmount := int64(4000)
	item.ApplySuggestion(ExpenseItemSuggestion{
		ReceiptType: "TAXI", ExpenseCategory: "交通费", Purpose: "市内出行打车费", AmountCent: &newAmount,
	})
	if item.ExpenseCategory != "市内交通费" || item.Purpose != "客户拜访打车" || *item.AmountCent != 3800 {
		t.Fatalf("manual fields overwritten: %+v", item)
	}
	if item.ReceiptType != "TAXI" {
		t.Fatalf("receipt type not updated: %+v", item)
	}
}

func TestExpenseItemSuggestionFillsOnlyKnownFields(t *testing.T) {
	item := ExpenseItem{ReceiptID: "receipt-1"}
	item.ApplySuggestion(ExpenseItemSuggestion{ReceiptType: "TAXI", Purpose: "市内出行打车费"})
	if item.Purpose != "市内出行打车费" || item.ExpenseCategory != "" || item.AmountCent != nil || item.ProjectCode != "" || len(item.Participants) != 0 {
		t.Fatalf("unexpected inferred fields: %+v", item)
	}
}
