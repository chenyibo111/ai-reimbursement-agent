package application

import "testing"

func TestHasValidSignatureAcceptsPDFWithCompactPageTypeToken(t *testing.T) {
	content := []byte("%PDF-1.4\n1 0 obj\n<</Type/Page>>\nendobj\n")

	if !hasValidSignature("application/pdf", content) {
		t.Fatal("expected valid PDF signature with compact page type token")
	}
}
