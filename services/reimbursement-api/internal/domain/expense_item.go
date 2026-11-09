package domain

type FieldSource string

const (
	FieldSourceOCR    FieldSource = "OCR"
	FieldSourceModel  FieldSource = "MODEL"
	FieldSourceManual FieldSource = "MANUAL"
)

type ExpenseItem struct {
	ID              string
	ClaimID         string
	ReceiptID       string
	ReceiptType     string
	ExpenseCategory string
	CategorySource  FieldSource
	Purpose         string
	PurposeSource   FieldSource
	AmountCent      *int64
	AmountSource    FieldSource
	ProjectCode     string
	Participants    []string
}

type ExpenseItemSuggestion struct {
	ReceiptType     string
	ExpenseCategory string
	Purpose         string
	AmountCent      *int64
}

type ExpenseItemPatch struct {
	ExpenseCategory *string
	Purpose         *string
	AmountCent      *int64
	ProjectCode     *string
	Participants    *[]string
}

func (item *ExpenseItem) ApplySuggestion(suggestion ExpenseItemSuggestion) {
	if suggestion.ReceiptType != "" {
		item.ReceiptType = suggestion.ReceiptType
	}
	if suggestion.ExpenseCategory != "" && item.CategorySource != FieldSourceManual {
		item.ExpenseCategory = suggestion.ExpenseCategory
		item.CategorySource = FieldSourceModel
	}
	if suggestion.Purpose != "" && item.PurposeSource != FieldSourceManual {
		item.Purpose = suggestion.Purpose
		item.PurposeSource = FieldSourceModel
	}
	if suggestion.AmountCent != nil && item.AmountSource != FieldSourceManual {
		amount := *suggestion.AmountCent
		item.AmountCent = &amount
		item.AmountSource = FieldSourceOCR
	}
}
