package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

func TestReceiptPreviewServiceIssuesShortLivedURLForFinanceReviewer(t *testing.T) {
	expiresAt := time.Date(2026, time.October, 23, 12, 10, 0, 0, time.UTC)
	objects := &previewObjectStore{url: "https://files.example/receipts/receipt-1?signature=safe", expiresAt: expiresAt}
	service := NewReceiptPreviewService(
		NewMemoryReviewCaseRepository(ReviewCase{ID: "review-1", ReceiptID: "receipt-1"}),
		previewReceiptLookup{receipt: domain.Receipt{ID: "receipt-1", ObjectKey: "receipts/receipt-1"}},
		objects,
	)

	preview, err := service.Get(context.Background(), "FINANCE_REVIEWER", "review-1")

	if err != nil {
		t.Fatalf("get preview: %v", err)
	}
	if preview.URL != "https://files.example/receipts/receipt-1?signature=safe" || !preview.ExpiresAt.Equal(expiresAt) {
		t.Fatalf("preview = %#v", preview)
	}
	if objects.objectKey != "receipts/receipt-1" {
		t.Fatalf("object key = %q", objects.objectKey)
	}
}

func TestReceiptPreviewServiceRejectsEmployeeBeforeLookingUpReceipt(t *testing.T) {
	lookup := previewReceiptLookup{receipt: domain.Receipt{ID: "receipt-1", ObjectKey: "receipts/receipt-1"}}
	service := NewReceiptPreviewService(
		NewMemoryReviewCaseRepository(ReviewCase{ID: "review-1", ReceiptID: "receipt-1"}),
		lookup,
		&previewObjectStore{},
	)

	_, err := service.Get(context.Background(), "EMPLOYEE", "review-1")

	if !errors.Is(err, ErrReviewCaseForbidden) {
		t.Fatalf("error = %v, want forbidden", err)
	}
}

func TestReceiptPreviewServiceReturnsSafeUnavailableErrorWhenObjectCannotBeSigned(t *testing.T) {
	service := NewReceiptPreviewService(
		NewMemoryReviewCaseRepository(ReviewCase{ID: "review-1", ReceiptID: "receipt-1"}),
		previewReceiptLookup{receipt: domain.Receipt{ID: "receipt-1", ObjectKey: "receipts/receipt-1"}},
		&previewObjectStore{err: errors.New("minio says NoSuchKey")},
	)

	_, err := service.Get(context.Background(), "ADMIN", "review-1")

	if !errors.Is(err, ErrReceiptPreviewUnavailable) {
		t.Fatalf("error = %v, want unavailable", err)
	}
}

type previewReceiptLookup struct {
	receipt domain.Receipt
	err     error
}

func (lookup previewReceiptLookup) FindByID(context.Context, string) (domain.Receipt, error) {
	return lookup.receipt, lookup.err
}

type previewObjectStore struct {
	url       string
	expiresAt time.Time
	err       error
	objectKey string
}

func (store *previewObjectStore) CreateDownloadURL(_ context.Context, objectKey string) (string, time.Time, error) {
	store.objectKey = objectKey
	return store.url, store.expiresAt, store.err
}
