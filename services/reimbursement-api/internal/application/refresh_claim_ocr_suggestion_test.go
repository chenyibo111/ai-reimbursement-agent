package application

import (
	"context"
	"testing"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

func TestExtractReceiptRefreshesOCRSuggestedAmount(t *testing.T) {
	refresher := &recordingOCRSuggestionRefresher{}
	objects := &fakeObjectStore{objects: map[string]StoredObject{"receipts/receipt-1": {ContentType: "image/png", Content: validPNG()}}}
	repository := &fakeReceiptRepository{receipts: map[string]domain.Receipt{
		"receipt-1": {ID: "receipt-1", ClaimID: "claim-1", OwnerID: "employee-1", ObjectKey: "receipts/receipt-1", Status: domain.ReceiptStatusReadyForOCR},
	}, submittedInvoiceNumbers: make(map[string]bool)}
	service := NewReceiptService(fakeClaimReader{}, repository, objects, &fakeScanner{}, &fakeOCRClient{result: OCRResult{Confidence: 0.98}}, NewSequentialIDGenerator(), refresher)

	if err := service.ExtractReceipt(context.Background(), "employee-1", "claim-1", "receipt-1"); err != nil {
		t.Fatalf("extract receipt: %v", err)
	}
	if refresher.calls != 1 || refresher.claimID != "claim-1" || refresher.actorID != "employee-1" {
		t.Fatalf("refresh calls=%d claimID=%q actorID=%q", refresher.calls, refresher.claimID, refresher.actorID)
	}
}

type recordingOCRSuggestionRefresher struct {
	calls   int
	claimID string
	actorID string
}

func (refresher *recordingOCRSuggestionRefresher) RefreshOCRSuggestion(_ context.Context, claimID string, actorID string) error {
	refresher.calls++
	refresher.claimID = claimID
	refresher.actorID = actorID
	return nil
}
