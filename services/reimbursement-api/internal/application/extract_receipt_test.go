package application

import (
	"context"
	"errors"
	"testing"
)

func TestExtractReceiptFlagsDuplicateSubmittedInvoice(t *testing.T) {
	service := newReceiptServiceForTest(t)
	receipt, err := service.CreateUploadSession(context.Background(), "employee-1", "claim-1", CreateUploadSessionCommand{Filename: "invoice.pdf", ContentType: "application/pdf", SizeBytes: 1024})
	if err != nil {
		t.Fatalf("create upload session: %v", err)
	}
	service.objects.Put(receipt.ObjectKey, "application/pdf", validPDF())
	if err := service.FinalizeReceiptUpload(context.Background(), "employee-1", "claim-1", receipt.ReceiptID); err != nil {
		t.Fatalf("finalize upload: %v", err)
	}
	service.repository.submittedInvoiceNumbers["INV-SUBMITTED"] = true
	service.ocr.result = OCRResult{InvoiceNumber: "INV-SUBMITTED", Confidence: 0.98}

	err = service.ExtractReceipt(context.Background(), "employee-1", "claim-1", receipt.ReceiptID)
	if !errors.Is(err, ErrDuplicateSubmittedInvoice) {
		t.Fatalf("expected ErrDuplicateSubmittedInvoice, got %v", err)
	}
}
