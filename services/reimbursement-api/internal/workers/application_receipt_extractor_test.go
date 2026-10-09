package workers

import (
	"context"
	"testing"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

func TestApplicationReceiptExtractorTreatsDeletedReceiptAsHandled(t *testing.T) {
	extractor := NewApplicationReceiptExtractor(receiptLookupNotFound{}, nil)

	if err := extractor.Extract(context.Background(), "receipt-deleted"); err != nil {
		t.Fatalf("expected deleted receipt event to be handled, got %v", err)
	}
}

type receiptLookupNotFound struct{}

func (receiptLookupNotFound) FindByID(context.Context, string) (domain.Receipt, error) {
	return domain.Receipt{}, application.ErrReceiptNotFound
}
