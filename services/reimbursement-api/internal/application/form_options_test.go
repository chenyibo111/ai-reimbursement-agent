package application

import (
	"encoding/json"
	"testing"
)

func TestFormOptionsRejectsUnknownFieldsAndUnverifiedProjectCatalog(t *testing.T) {
	for _, payload := range []string{
		`null`,
		`{"fieldOrder":["purpose","unknown"]}`,
		`{"fieldOrder":["purpose","purpose"]}`,
		`{"projectCodeMode":"CATALOG","projectCodes":[{"code":"P1","label":"项目一","enabled":true}]}`,
		`{"categoryHelpText":"说明","unexpected":true}`,
	} {
		if err := ValidateFormOptionsPayload(json.RawMessage(payload)); err == nil {
			t.Fatalf("accepted invalid form options: %s", payload)
		}
	}
}

func TestFormOptionsAcceptsExistingFieldHintsAndOrder(t *testing.T) {
	payload := json.RawMessage(`{"categoryHelpText":"请按实际费用选择类别","projectCodeMode":"FREE_TEXT","projectCodes":[],"fieldOrder":["projectCode","purpose","expenseCategory","participants","requestedAmountCent","currency","remark"]}`)
	if err := ValidateFormOptionsPayload(payload); err != nil {
		t.Fatalf("valid form options rejected: %v", err)
	}
}
