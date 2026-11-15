package application

import (
	"context"
	"encoding/json"
	"errors"
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

func TestExtractReceiptRefreshesSummaryWhenRetryMovesReceiptToReview(t *testing.T) {
	refresher := &recordingOCRSuggestionRefresher{}
	amount := int64(3800)
	repository := &fakeReceiptRepository{receipts: map[string]domain.Receipt{"receipt-1": {ID: "receipt-1", ClaimID: "claim-1", OwnerID: "employee-1", ObjectKey: "receipts/receipt-1", Status: domain.ReceiptStatusExtracted, TotalAmountCent: &amount}}, submittedInvoiceNumbers: make(map[string]bool), reviewReasons: make(map[string][]string)}
	service := NewReceiptService(itemizedClaimReader{}, repository, &fakeObjectStore{objects: map[string]StoredObject{"receipts/receipt-1": {ContentType: "image/png", Content: validPNG()}}}, &fakeScanner{}, &fakeOCRClient{result: OCRResult{TotalAmountCent: &amount, Confidence: 0.69}}, NewSequentialIDGenerator(), refresher)
	if err := service.ExtractReceipt(context.Background(), "employee-1", "claim-1", "receipt-1"); !errors.Is(err, ErrLowOCRConfidence) {
		t.Fatalf("expected review, got %v", err)
	}
	if refresher.calls != 1 {
		t.Fatalf("review transition did not refresh claim summary: %+v", refresher)
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

func TestExtractReceiptClassifiesItemizedReceiptWithoutChangingOCRAmount(t *testing.T) {
	amount := int64(3800)
	items := &recordingExpenseItemSuggester{}
	repository := &fakeReceiptRepository{receipts: map[string]domain.Receipt{"taxi": {ID: "taxi", ClaimID: "claim-1", OwnerID: "employee-1", ObjectKey: "receipts/taxi", Status: domain.ReceiptStatusReadyForOCR}}, submittedInvoiceNumbers: map[string]bool{}}
	service := NewReceiptService(itemizedClaimReader{}, repository, &fakeObjectStore{objects: map[string]StoredObject{"receipts/taxi": {ContentType: "image/png", Content: validPNG()}}}, &fakeScanner{}, &fakeOCRClient{result: OCRResult{Text: "滴滴出行 网约车运输服务", TotalAmountCent: &amount, Confidence: 0.98}}, NewSequentialIDGenerator())
	service.SetExpenseItemSuggester(items)
	service.SetReceiptClassifier(fakeReceiptClassifier{suggestion: ClassificationSuggestion{ReceiptType: "TAXI", ExpenseCategory: "市内交通费", Purpose: "市内出行打车费"}}, testCachedCatalogReader())
	if err := service.ExtractReceipt(context.Background(), "employee-1", "claim-1", "taxi"); err != nil {
		t.Fatal(err)
	}
	if items.calls != 1 || items.suggestion.ClassificationStatus != "CLASSIFIED" || items.suggestion.ReceiptType != "TAXI" || items.suggestion.ExpenseCategory != "市内交通费" || items.suggestion.Purpose != "市内出行打车费" || items.suggestion.AmountCent == nil || *items.suggestion.AmountCent != 3800 {
		t.Fatalf("suggestion=%+v", items.suggestion)
	}
}

func TestExtractReceiptKeepsOCRAmountWhenModelFails(t *testing.T) {
	amount := int64(5200)
	items := &recordingExpenseItemSuggester{}
	repository := &fakeReceiptRepository{receipts: map[string]domain.Receipt{"dining": {ID: "dining", ClaimID: "claim-1", OwnerID: "employee-1", ObjectKey: "receipts/dining", Status: domain.ReceiptStatusReadyForOCR}}, submittedInvoiceNumbers: map[string]bool{}}
	service := NewReceiptService(itemizedClaimReader{}, repository, &fakeObjectStore{objects: map[string]StoredObject{"receipts/dining": {ContentType: "image/png", Content: validPNG()}}}, &fakeScanner{}, &fakeOCRClient{result: OCRResult{Text: "餐饮服务", TotalAmountCent: &amount, Confidence: 0.98}}, NewSequentialIDGenerator())
	service.SetExpenseItemSuggester(items)
	service.SetReceiptClassifier(fakeReceiptClassifier{err: errors.New("model unavailable")}, testCachedCatalogReader())
	if err := service.ExtractReceipt(context.Background(), "employee-1", "claim-1", "dining"); err != nil {
		t.Fatal(err)
	}
	if items.calls != 1 || items.suggestion.ClassificationStatus != "FAILED" || items.suggestion.ReceiptType != "" || items.suggestion.ExpenseCategory != "" || items.suggestion.AmountCent == nil || *items.suggestion.AmountCent != 5200 {
		t.Fatalf("suggestion=%+v", items.suggestion)
	}
}

type itemizedClaimReader struct{ fakeClaimReader }

func (itemizedClaimReader) FindOwned(_ context.Context, claimID, actorID string) (domain.Claim, error) {
	return domain.Claim{ID: claimID, OwnerID: actorID, Status: domain.ClaimStatusDraft, ItemizationMode: domain.ClaimItemizationModeItemized}, nil
}

type recordingExpenseItemSuggester struct {
	calls      int
	receiptID  string
	amount     int64
	suggestion domain.ExpenseItemSuggestion
}

func (suggester *recordingExpenseItemSuggester) UpsertFromOCR(_ context.Context, _ string, receiptID string, suggestion domain.ExpenseItemSuggestion) (domain.ExpenseItem, error) {
	suggester.calls++
	suggester.suggestion = suggestion
	suggester.receiptID = receiptID
	if suggestion.AmountCent != nil {
		suggester.amount = *suggestion.AmountCent
	}
	return domain.ExpenseItem{ReceiptID: receiptID}, nil
}

type fakeReceiptClassifier struct {
	suggestion ClassificationSuggestion
	err        error
}

func (classifier fakeReceiptClassifier) Classify(context.Context, OCRResult, ExpenseCatalog) (ClassificationSuggestion, error) {
	return classifier.suggestion, classifier.err
}

func testCachedCatalogReader() *CachedExpenseCatalogReader {
	payload, _ := json.Marshal(testExpenseCatalog())
	return NewCachedExpenseCatalogReader(&changingCatalogSnapshotReader{snapshot: domain.ConfigSnapshot{Domain: "expense_catalog", Version: 1, Payload: payload}})
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
