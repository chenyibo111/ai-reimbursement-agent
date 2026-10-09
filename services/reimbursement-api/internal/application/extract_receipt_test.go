package application

import (
	"context"
	"errors"
	"testing"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
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

func TestExtractReceiptAllowsDuplicateSubmittedInvoiceWhenTestingOverrideIsEnabled(t *testing.T) {
	service := newReceiptServiceForTest(t)
	service.allowDuplicateSubmittedInvoiceForTesting = true
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

	if err := service.ExtractReceipt(context.Background(), "employee-1", "claim-1", receipt.ReceiptID); err != nil {
		t.Fatalf("extract duplicate submitted invoice in testing mode: %v", err)
	}
	stored, err := service.repository.FindOwned(context.Background(), receipt.ReceiptID, "claim-1", "employee-1")
	if err != nil {
		t.Fatalf("read extracted receipt: %v", err)
	}
	if stored.Status != domain.ReceiptStatusExtracted || stored.InvoiceNumber != "INV-SUBMITTED" {
		t.Fatalf("receipt = %#v, want extracted duplicate invoice result", stored)
	}
}
