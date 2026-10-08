package application

import (
	"context"
	"testing"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

func TestListReceiptsPreservesRecognizedAndMissingMetadata(t *testing.T) {
	invoiceDate := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	totalAmount := int64(10155)
	sellerName := "上海象鲜网络科技有限公司"
	repository := &fakeReceiptRepository{receipts: map[string]domain.Receipt{
		"recognized": {
			ID: "recognized", ClaimID: "claim-1", OwnerID: "employee-1", Filename: "recognized.pdf",
			Status: domain.ReceiptStatusExtracted, InvoiceNumber: "26317000001513684420",
			InvoiceDate: &invoiceDate, TotalAmountCent: &totalAmount, SellerName: &sellerName,
		},
		"missing": {
			ID: "missing", ClaimID: "claim-1", OwnerID: "employee-1", Filename: "missing.pdf",
			Status: domain.ReceiptStatusExtracted,
		},
	}}
	service := NewReceiptService(fakeClaimReader{}, repository, nil, nil, nil, NewSequentialIDGenerator())

	views, err := service.ListReceipts(context.Background(), "employee-1", "claim-1")
	if err != nil {
		t.Fatalf("list receipts: %v", err)
	}
	byID := make(map[string]ReceiptView, len(views))
	for _, view := range views {
		byID[view.ID] = view
	}
	if got := byID["recognized"]; got.InvoiceDate == nil || got.InvoiceDate.Format("2006-01-02") != "2026-05-01" || got.TotalAmountCent == nil || *got.TotalAmountCent != 10155 || got.SellerName == nil || *got.SellerName != sellerName {
		t.Fatalf("recognized metadata = %#v", got)
	}
	if got := byID["missing"]; got.InvoiceDate != nil || got.TotalAmountCent != nil || got.SellerName != nil {
		t.Fatalf("missing metadata = %#v, want nil values", got)
	}
}
