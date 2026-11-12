package application

import (
	"context"
	"errors"
	"testing"
)

func TestHasValidSignatureAcceptsPDFHeaderAndRejectsInvalidHeader(t *testing.T) {
	content := []byte("%PDF-1.4\n1 0 obj\n<</Type/Page>>\nendobj\n")

	if !hasValidSignature("application/pdf", content) {
		t.Fatal("expected PDF header to pass initial signature check")
	}
	if hasValidSignature("application/pdf", []byte("not a PDF")) {
		t.Fatal("invalid PDF header passed signature check")
	}
}

func TestFinalizeReceiptUploadAcceptsPDFWithCompressedPageObjects(t *testing.T) {
	service := newReceiptServiceForTest(t)
	receipt, err := service.CreateUploadSession(context.Background(), "employee-1", "claim-1", CreateUploadSessionCommand{Filename: "invoice.pdf", ContentType: "application/pdf", SizeBytes: 64})
	if err != nil {
		t.Fatal(err)
	}
	service.objects.Put(receipt.ObjectKey, "application/pdf", []byte("%PDF-1.6\n1 0 obj\n<< /Type /ObjStm >>\nendobj\n%%EOF"))
	if err := service.FinalizeReceiptUpload(context.Background(), "employee-1", "claim-1", receipt.ReceiptID); err != nil {
		t.Fatalf("valid PDF was rejected before OCR: %v", err)
	}
	if service.ocr.pdfValidationCalls != 1 {
		t.Fatalf("PDF validator calls=%d, want 1", service.ocr.pdfValidationCalls)
	}
}

func TestFinalizeReceiptUploadRejectsPDFWithTooManyPages(t *testing.T) {
	service := newReceiptServiceForTest(t)
	service.ocr.pdfPages = MaxPDFPages + 1
	receipt, err := service.CreateUploadSession(context.Background(), "employee-1", "claim-1", CreateUploadSessionCommand{Filename: "invoice.pdf", ContentType: "application/pdf", SizeBytes: 64})
	if err != nil {
		t.Fatal(err)
	}
	service.objects.Put(receipt.ObjectKey, "application/pdf", validPDF())
	if err := service.FinalizeReceiptUpload(context.Background(), "employee-1", "claim-1", receipt.ReceiptID); !errors.Is(err, ErrInvalidFileSignature) {
		t.Fatalf("overlimit PDF error=%v", err)
	}
}

func TestFinalizeReceiptUploadScansPDFBeforeParsing(t *testing.T) {
	service := newReceiptServiceForTest(t)
	service.scanner.unsafe = true
	receipt, err := service.CreateUploadSession(context.Background(), "employee-1", "claim-1", CreateUploadSessionCommand{Filename: "invoice.pdf", ContentType: "application/pdf", SizeBytes: 64})
	if err != nil {
		t.Fatal(err)
	}
	service.objects.Put(receipt.ObjectKey, "application/pdf", validPDF())
	if err := service.FinalizeReceiptUpload(context.Background(), "employee-1", "claim-1", receipt.ReceiptID); !errors.Is(err, ErrUnsafeReceiptFile) {
		t.Fatalf("unsafe PDF error=%v", err)
	}
	if service.ocr.pdfValidationCalls != 0 {
		t.Fatalf("parsed unsafe PDF %d times", service.ocr.pdfValidationCalls)
	}
}
