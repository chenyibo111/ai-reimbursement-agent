package application

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

type testReceiptService struct {
	*ReceiptService
	objects    *fakeObjectStore
	scanner    *fakeScanner
	ocr        *fakeOCRClient
	repository *fakeReceiptRepository
}

func newReceiptServiceForTest(t *testing.T) *testReceiptService {
	t.Helper()
	objects := &fakeObjectStore{objects: make(map[string]StoredObject)}
	repository := &fakeReceiptRepository{receipts: make(map[string]domain.Receipt), submittedInvoiceNumbers: make(map[string]bool)}
	scanner := &fakeScanner{}
	ocr := &fakeOCRClient{}
	return &testReceiptService{
		ReceiptService: NewReceiptService(fakeClaimReader{}, repository, objects, scanner, ocr, NewSequentialIDGenerator()),
		objects:        objects,
		scanner:        scanner,
		ocr:            ocr,
		repository:     repository,
	}
}

type fakeClaimReader struct{}

func (fakeClaimReader) FindOwned(_ context.Context, claimID string, actorID string) (domain.Claim, error) {
	if claimID != "claim-1" || actorID != "employee-1" {
		return domain.Claim{}, ErrClaimNotFound
	}
	return domain.Claim{ID: claimID, OwnerID: actorID, Status: domain.ClaimStatusDraft, Version: 1}, nil
}

type fakeObjectStore struct {
	objects map[string]StoredObject
}

func (store *fakeObjectStore) CreateUploadURL(_ context.Context, objectKey string, _ string, _ int64) (string, error) {
	return "memory://" + objectKey, nil
}

func (store *fakeObjectStore) ReadObject(_ context.Context, objectKey string) (StoredObject, error) {
	object, found := store.objects[objectKey]
	if !found {
		return StoredObject{}, fmt.Errorf("object not found")
	}
	return object, nil
}

func (store *fakeObjectStore) Put(objectKey string, contentType string, content []byte) {
	store.objects[objectKey] = StoredObject{ContentType: contentType, Content: content}
}

type fakeScanner struct{ unsafe bool }

func (scanner *fakeScanner) Scan(_ context.Context, _ []byte) (bool, error) {
	return scanner.unsafe, nil
}

type fakeOCRClient struct{ result OCRResult }

func (client *fakeOCRClient) Extract(_ context.Context, _ StoredObject) (OCRResult, error) {
	return client.result, nil
}

type fakeReceiptRepository struct {
	mu                      sync.Mutex
	receipts                map[string]domain.Receipt
	submittedInvoiceNumbers map[string]bool
}

func (repository *fakeReceiptRepository) Create(_ context.Context, receipt domain.Receipt) error {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	repository.receipts[receipt.ID] = receipt
	return nil
}

func (repository *fakeReceiptRepository) FindOwned(_ context.Context, receiptID string, claimID string, actorID string) (domain.Receipt, error) {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	receipt, found := repository.receipts[receiptID]
	if !found || receipt.ClaimID != claimID || receipt.OwnerID != actorID {
		return domain.Receipt{}, ErrReceiptNotFound
	}
	return receipt, nil
}

func (repository *fakeReceiptRepository) FindByContentHash(_ context.Context, hash string) (domain.Receipt, error) {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	for _, receipt := range repository.receipts {
		if receipt.ContentHash == hash && receipt.Status != domain.ReceiptStatusUploadPending {
			return receipt, nil
		}
	}
	return domain.Receipt{}, ErrReceiptNotFound
}

func (repository *fakeReceiptRepository) MarkReadyForOCR(_ context.Context, receiptID string, hash string) error {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	receipt := repository.receipts[receiptID]
	receipt.ContentHash = hash
	receipt.Status = domain.ReceiptStatusReadyForOCR
	repository.receipts[receiptID] = receipt
	return nil
}

func (repository *fakeReceiptRepository) MarkReviewRequired(_ context.Context, receiptID string, _ string) error {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	receipt := repository.receipts[receiptID]
	receipt.Status = domain.ReceiptStatusReview
	repository.receipts[receiptID] = receipt
	return nil
}

func (repository *fakeReceiptRepository) MarkExtracted(_ context.Context, receiptID string, result OCRResult) error {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	receipt := repository.receipts[receiptID]
	receipt.InvoiceNumber = result.InvoiceNumber
	receipt.OCRConfidence = result.Confidence
	receipt.Status = domain.ReceiptStatusExtracted
	repository.receipts[receiptID] = receipt
	return nil
}

func (repository *fakeReceiptRepository) HasSubmittedInvoice(_ context.Context, invoiceNumber string) (bool, error) {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	return repository.submittedInvoiceNumbers[invoiceNumber], nil
}

func validPNG() []byte { return []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3} }

func validPDF() []byte { return []byte("%PDF-1.7\n1 0 obj\n<< /Type /Page >>") }
