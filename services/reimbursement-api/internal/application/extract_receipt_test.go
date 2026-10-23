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
	stored, err := service.repository.FindOwned(context.Background(), receipt.ReceiptID, "claim-1", "employee-1")
	if err != nil {
		t.Fatalf("read review-required receipt: %v", err)
	}
	if stored.Status != domain.ReceiptStatusReview || stored.InvoiceNumber != "INV-SUBMITTED" || stored.OCRConfidence != 0.98 {
		t.Fatalf("receipt = %#v, want persisted OCR candidate in review", stored)
	}
	if reasons := service.repository.reviewReasons[receipt.ReceiptID]; len(reasons) != 1 || reasons[0] != "DUPLICATE_SUBMITTED_INVOICE" {
		t.Fatalf("review reasons = %#v", reasons)
	}
}

func TestExtractReceiptFlagsLowConfidenceForReview(t *testing.T) {
	service := newReceiptServiceForTest(t)
	receipt, err := service.CreateUploadSession(context.Background(), "employee-1", "claim-1", CreateUploadSessionCommand{Filename: "invoice.pdf", ContentType: "application/pdf", SizeBytes: 1024})
	if err != nil {
		t.Fatalf("create upload session: %v", err)
	}
	service.objects.Put(receipt.ObjectKey, "application/pdf", validPDF())
	if err := service.FinalizeReceiptUpload(context.Background(), "employee-1", "claim-1", receipt.ReceiptID); err != nil {
		t.Fatalf("finalize upload: %v", err)
	}
	amount := int64(10155)
	service.ocr.result = OCRResult{InvoiceNumber: "INV-LOW", TotalAmountCent: &amount, Confidence: 0.69}

	err = service.ExtractReceipt(context.Background(), "employee-1", "claim-1", receipt.ReceiptID)
	if !errors.Is(err, ErrLowOCRConfidence) {
		t.Fatalf("extract error = %v, want low-confidence review", err)
	}
	stored, err := service.repository.FindOwned(context.Background(), receipt.ReceiptID, "claim-1", "employee-1")
	if err != nil {
		t.Fatalf("read review-required receipt: %v", err)
	}
	if stored.Status != domain.ReceiptStatusReview || stored.TotalAmountCent == nil || *stored.TotalAmountCent != amount || stored.OCRConfidence != 0.69 {
		t.Fatalf("receipt = %#v, want persisted low-confidence candidate", stored)
	}
	if reasons := service.repository.reviewReasons[receipt.ReceiptID]; len(reasons) != 1 || reasons[0] != "OCR_LOW_CONFIDENCE" {
		t.Fatalf("review reasons = %#v", reasons)
	}
}

func TestExtractReceiptDoesNotFlagConfidenceAtThreshold(t *testing.T) {
	service := newReceiptServiceForTest(t)
	receipt, err := service.CreateUploadSession(context.Background(), "employee-1", "claim-1", CreateUploadSessionCommand{Filename: "invoice.pdf", ContentType: "application/pdf", SizeBytes: 1024})
	if err != nil {
		t.Fatalf("create upload session: %v", err)
	}
	service.objects.Put(receipt.ObjectKey, "application/pdf", validPDF())
	if err := service.FinalizeReceiptUpload(context.Background(), "employee-1", "claim-1", receipt.ReceiptID); err != nil {
		t.Fatalf("finalize upload: %v", err)
	}
	service.ocr.result = OCRResult{InvoiceNumber: "INV-THRESHOLD", Confidence: 0.70}

	if err := service.ExtractReceipt(context.Background(), "employee-1", "claim-1", receipt.ReceiptID); err != nil {
		t.Fatalf("extract at threshold: %v", err)
	}
	stored, err := service.repository.FindOwned(context.Background(), receipt.ReceiptID, "claim-1", "employee-1")
	if err != nil {
		t.Fatalf("read extracted receipt: %v", err)
	}
	if stored.Status != domain.ReceiptStatusExtracted || len(service.repository.reviewReasons[receipt.ReceiptID]) != 0 {
		t.Fatalf("receipt = %#v, reasons = %#v", stored, service.repository.reviewReasons[receipt.ReceiptID])
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
