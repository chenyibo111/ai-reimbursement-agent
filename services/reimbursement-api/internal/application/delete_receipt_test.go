package application

import (
	"context"
	"errors"
	"testing"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

func TestDeleteReceiptRemovesDraftReceiptAndStoredObject(t *testing.T) {
	service := newReceiptServiceForTest(t)
	receipt, err := service.CreateUploadSession(context.Background(), "employee-1", "claim-1", CreateUploadSessionCommand{Filename: "invoice.png", ContentType: "image/png", SizeBytes: 12})
	if err != nil {
		t.Fatalf("create upload session: %v", err)
	}
	service.objects.Put(receipt.ObjectKey, "image/png", validPNG())

	if err := service.DeleteReceipt(context.Background(), "employee-1", "claim-1", receipt.ReceiptID); err != nil {
		t.Fatalf("delete receipt: %v", err)
	}
	if _, found := service.repository.receipts[receipt.ReceiptID]; found {
		t.Fatal("expected receipt record to be deleted")
	}
	if _, found := service.objects.objects[receipt.ObjectKey]; found {
		t.Fatal("expected stored object to be deleted")
	}
}

func TestDeleteReceiptRejectsSubmittedClaim(t *testing.T) {
	objects := &fakeObjectStore{objects: make(map[string]StoredObject)}
	repository := &fakeReceiptRepository{receipts: map[string]domain.Receipt{
		"receipt-1": {ID: "receipt-1", ClaimID: "claim-1", OwnerID: "employee-1", ObjectKey: "receipts/receipt-1"},
	}, submittedInvoiceNumbers: make(map[string]bool)}
	objects.Put("receipts/receipt-1", "image/png", validPNG())
	service := NewReceiptService(submittedClaimReader{}, repository, objects, &fakeScanner{}, &fakeOCRClient{}, NewSequentialIDGenerator())

	err := service.DeleteReceipt(context.Background(), "employee-1", "claim-1", "receipt-1")
	if !errors.Is(err, domain.ErrClaimNotDraft) {
		t.Fatalf("expected ErrClaimNotDraft, got %v", err)
	}
	if _, found := repository.receipts["receipt-1"]; !found {
		t.Fatal("expected receipt record to remain")
	}
	if _, found := objects.objects["receipts/receipt-1"]; !found {
		t.Fatal("expected stored object to remain")
	}
}

type submittedClaimReader struct{}

func (submittedClaimReader) FindOwned(_ context.Context, claimID string, actorID string) (domain.Claim, error) {
	if claimID != "claim-1" || actorID != "employee-1" {
		return domain.Claim{}, ErrClaimNotFound
	}
	return domain.Claim{ID: claimID, OwnerID: actorID, Status: domain.ClaimStatusSubmitted}, nil
}
