package workers

import (
	"context"
	"errors"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

type ReceiptLookup interface {
	FindByID(context.Context, string) (domain.Receipt, error)
}

// ApplicationReceiptExtractor translates a trusted receipt event back to the
// owned command required by the application service. The event contains no
// object key and the worker still reads data through the Go domain boundary.
type ApplicationReceiptExtractor struct {
	lookup  ReceiptLookup
	service *application.ReceiptService
}

func NewApplicationReceiptExtractor(lookup ReceiptLookup, service *application.ReceiptService) *ApplicationReceiptExtractor {
	return &ApplicationReceiptExtractor{lookup: lookup, service: service}
}

func (extractor *ApplicationReceiptExtractor) Extract(ctx context.Context, receiptID string) error {
	receipt, err := extractor.lookup.FindByID(ctx, receiptID)
	// A draft attachment can be deleted after its OCR event has been published.
	// There is no longer anything to extract, so acknowledge the stale event
	// instead of retrying it and eventually creating a phantom review case.
	if errors.Is(err, application.ErrReceiptNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return extractor.service.ExtractReceipt(ctx, receipt.OwnerID, receipt.ClaimID, receipt.ID)
}
