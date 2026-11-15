package domain

type FieldSource string

const (
	FieldSourceOCR    FieldSource = "OCR"
	FieldSourceModel  FieldSource = "MODEL"
	FieldSourceManual FieldSource = "MANUAL"
)

type ExpenseItem struct {
	ID                     string
	ClaimID                string
	ReceiptID              string
	ReceiptType            string
	ClassificationStatus   string
	ClassificationVersion  string
	ExpenseCategory        string
	CategoryCode           string
	ExpenseCatalogVersion  int64
	CategoryReviewRequired bool
	CategorySource         FieldSource
	Purpose                string
	PurposeSource          FieldSource
	AmountCent             *int64
	AmountSource           FieldSource
	ProjectCode            string
	Participants           []string
}

type ExpenseItemSuggestion struct {
	ReceiptType           string
	ClassificationStatus  string
	ClassificationVersion string
	ExpenseCategory       string
	CategoryCode          string
	ExpenseCatalogVersion int64
	Purpose               string
	AmountCent            *int64
}

type ExpenseItemPatch struct {
	ExpenseCategory *string
	Purpose         *string
	AmountCent      *int64
	ProjectCode     *string
	Participants    *[]string
}

func (item *ExpenseItem) ApplySuggestion(suggestion ExpenseItemSuggestion) {
	fullRefresh := suggestion.ClassificationStatus != ""
	if fullRefresh {
		item.ClassificationStatus = suggestion.ClassificationStatus
		item.ClassificationVersion = suggestion.ClassificationVersion
	}
	if fullRefresh || suggestion.ReceiptType != "" {
		item.ReceiptType = suggestion.ReceiptType
	}
	if item.CategorySource != FieldSourceManual && (fullRefresh || suggestion.ExpenseCategory != "") {
		item.ExpenseCategory = suggestion.ExpenseCategory
		item.CategoryCode = suggestion.CategoryCode
		item.ExpenseCatalogVersion = suggestion.ExpenseCatalogVersion
		item.CategoryReviewRequired = item.ExpenseCategory != "" && item.CategoryCode == ""
		item.CategorySource = ""
		if suggestion.ExpenseCategory != "" {
			item.CategorySource = FieldSourceModel
		}
	}
	if item.PurposeSource != FieldSourceManual && (fullRefresh || suggestion.Purpose != "") {
		item.Purpose = suggestion.Purpose
		item.PurposeSource = ""
		if suggestion.Purpose != "" {
			item.PurposeSource = FieldSourceModel
		}
	}
	if item.AmountSource != FieldSourceManual && (fullRefresh || suggestion.AmountCent != nil) {
		item.AmountCent = nil
		item.AmountSource = ""
		if suggestion.AmountCent != nil {
			amount := *suggestion.AmountCent
			item.AmountCent = &amount
			item.AmountSource = FieldSourceOCR
		}
	}
}
