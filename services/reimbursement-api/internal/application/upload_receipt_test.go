package application

import (
	"context"
	"errors"
	"testing"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

func TestFinalizeReceiptUploadRejectsInvalidSignature(t *testing.T) {
	service := newReceiptServiceForTest(t)
	receipt, err := service.CreateUploadSession(context.Background(), "employee-1", "claim-1", CreateUploadSessionCommand{Filename: "invoice.jpg", ContentType: "image/jpeg", SizeBytes: 10})
	if err != nil {
		t.Fatalf("create upload session: %v", err)
	}
	service.objects.Put(receipt.ObjectKey, "image/jpeg", []byte("not-a-jpeg"))

	err = service.FinalizeReceiptUpload(context.Background(), "employee-1", "claim-1", receipt.ReceiptID)
	if !errors.Is(err, ErrInvalidFileSignature) {
		t.Fatalf("expected ErrInvalidFileSignature, got %v", err)
	}
}

func TestFinalizeReceiptUploadRejectsUnsafeFile(t *testing.T) {
	service := newReceiptServiceForTest(t)
	receipt, err := service.CreateUploadSession(context.Background(), "employee-1", "claim-1", CreateUploadSessionCommand{Filename: "invoice.png", ContentType: "image/png", SizeBytes: 12})
	if err != nil {
		t.Fatalf("create upload session: %v", err)
	}
	service.objects.Put(receipt.ObjectKey, "image/png", validPNG())
	service.scanner.unsafe = true

	err = service.FinalizeReceiptUpload(context.Background(), "employee-1", "claim-1", receipt.ReceiptID)
	if !errors.Is(err, ErrUnsafeReceiptFile) {
		t.Fatalf("expected ErrUnsafeReceiptFile, got %v", err)
	}
}

func TestFinalizeReceiptUploadRejectsDuplicateContent(t *testing.T) {
	service := newReceiptServiceForTest(t)
	first, err := service.CreateUploadSession(context.Background(), "employee-1", "claim-1", CreateUploadSessionCommand{Filename: "first.png", ContentType: "image/png", SizeBytes: 12})
	if err != nil {
		t.Fatalf("create first upload session: %v", err)
	}
	service.objects.Put(first.ObjectKey, "image/png", validPNG())
	if err := service.FinalizeReceiptUpload(context.Background(), "employee-1", "claim-1", first.ReceiptID); err != nil {
		t.Fatalf("finalize first upload: %v", err)
	}
	second, err := service.CreateUploadSession(context.Background(), "employee-1", "claim-1", CreateUploadSessionCommand{Filename: "second.png", ContentType: "image/png", SizeBytes: 12})
	if err != nil {
		t.Fatalf("create second upload session: %v", err)
	}
	service.objects.Put(second.ObjectKey, "image/png", validPNG())

	err = service.FinalizeReceiptUpload(context.Background(), "employee-1", "claim-1", second.ReceiptID)
	if !errors.Is(err, ErrDuplicateReceiptContent) {
		t.Fatalf("expected ErrDuplicateReceiptContent, got %v", err)
	}
}

func TestFinalizeReceiptUploadAllowsDuplicateContentForTesting(t *testing.T) {
	objects := &fakeObjectStore{objects: make(map[string]StoredObject)}
	repository := &fakeReceiptRepository{receipts: make(map[string]domain.Receipt), submittedInvoiceNumbers: make(map[string]bool)}
	service := NewReceiptServiceWithOptions(
		fakeClaimReader{}, repository, objects, &fakeScanner{}, &fakeOCRClient{}, NewSequentialIDGenerator(),
		ReceiptServiceOptions{AllowDuplicateContentForTesting: true},
	)

	first, err := service.CreateUploadSession(context.Background(), "employee-1", "claim-1", CreateUploadSessionCommand{Filename: "first.png", ContentType: "image/png", SizeBytes: 12})
	if err != nil {
		t.Fatalf("create first upload session: %v", err)
	}
	objects.Put(first.ObjectKey, "image/png", validPNG())
	if err := service.FinalizeReceiptUpload(context.Background(), "employee-1", "claim-1", first.ReceiptID); err != nil {
		t.Fatalf("finalize first upload: %v", err)
	}

	second, err := service.CreateUploadSession(context.Background(), "employee-1", "claim-1", CreateUploadSessionCommand{Filename: "second.png", ContentType: "image/png", SizeBytes: 12})
	if err != nil {
		t.Fatalf("create second upload session: %v", err)
	}
	objects.Put(second.ObjectKey, "image/png", validPNG())
	if err := service.FinalizeReceiptUpload(context.Background(), "employee-1", "claim-1", second.ReceiptID); err != nil {
		t.Fatalf("expected duplicate testing upload to proceed, got %v", err)
	}

	firstStored := repository.receipts[first.ReceiptID]
	secondStored := repository.receipts[second.ReceiptID]
	if firstStored.Status != domain.ReceiptStatusReadyForOCR || secondStored.Status != domain.ReceiptStatusReadyForOCR {
		t.Fatalf("expected both receipts ready for OCR, got %s and %s", firstStored.Status, secondStored.Status)
	}
	if firstStored.ContentHash == secondStored.ContentHash {
		t.Fatal("expected test-mode duplicate receipts to retain distinct stored hashes")
	}
}
