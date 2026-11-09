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

func TestExtractReceiptCreatesExpenseItemForItemizedClaim(t *testing.T) {
	amount := int64(3800)
	items := &recordingExpenseItemSuggester{}
	refresher := &recordingOCRSuggestionRefresher{}
	objects := &fakeObjectStore{objects: map[string]StoredObject{"receipts/receipt-1": {ContentType: "image/png", Content: validPNG()}}}
	repository := &fakeReceiptRepository{receipts: map[string]domain.Receipt{
		"receipt-1": {ID: "receipt-1", ClaimID: "claim-1", OwnerID: "employee-1", ObjectKey: "receipts/receipt-1", Status: domain.ReceiptStatusReadyForOCR},
	}, submittedInvoiceNumbers: make(map[string]bool)}
	service := NewReceiptService(itemizedClaimReader{}, repository, objects, &fakeScanner{}, &fakeOCRClient{result: OCRResult{TotalAmountCent: &amount, Confidence: 0.98}}, NewSequentialIDGenerator(), refresher)
	service.SetExpenseItemSuggester(items)
	if err := service.ExtractReceipt(context.Background(), "employee-1", "claim-1", "receipt-1"); err != nil {
		t.Fatal(err)
	}
	if items.calls != 1 || items.receiptID != "receipt-1" || items.amount != 3800 || refresher.calls != 1 {
		t.Fatalf("items=%+v refresher=%+v", items, refresher)
	}
}

type itemizedClaimReader struct{ fakeClaimReader }

func (itemizedClaimReader) FindOwned(_ context.Context, claimID, actorID string) (domain.Claim, error) {
	return domain.Claim{ID: claimID, OwnerID: actorID, Status: domain.ClaimStatusDraft, ItemizationMode: domain.ClaimItemizationModeItemized}, nil
}

type recordingExpenseItemSuggester struct {
	calls     int
	receiptID string
	amount    int64
}

func (suggester *recordingExpenseItemSuggester) UpsertFromOCR(_ context.Context, _ string, receiptID string, suggestion domain.ExpenseItemSuggestion) (domain.ExpenseItem, error) {
	suggester.calls++
	suggester.receiptID = receiptID
	if suggestion.AmountCent != nil {
		suggester.amount = *suggestion.AmountCent
	}
	return domain.ExpenseItem{ReceiptID: receiptID}, nil
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
