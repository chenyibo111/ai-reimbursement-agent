package application

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

var ErrReceiptPreviewUnavailable = errors.New("receipt preview is unavailable")

// ReceiptPreview contains only a temporary browser URL. Object keys and
// storage credentials stay inside the API and object-store implementation.
type ReceiptPreview struct {
	URL       string    `json:"url"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type ReceiptPreviewReceiptLookup interface {
	FindByID(context.Context, string) (domain.Receipt, error)
}

type ReceiptPreviewObjectStore interface {
	CreateDownloadURL(context.Context, string) (string, time.Time, error)
}

type ReceiptPreviewService struct {
	reviews  ReviewCaseRepository
	receipts ReceiptPreviewReceiptLookup
	objects  ReceiptPreviewObjectStore
}

func NewReceiptPreviewService(reviews ReviewCaseRepository, receipts ReceiptPreviewReceiptLookup, objects ReceiptPreviewObjectStore) *ReceiptPreviewService {
	return &ReceiptPreviewService{reviews: reviews, receipts: receipts, objects: objects}
}

func (service *ReceiptPreviewService) Get(ctx context.Context, role string, reviewID string) (ReceiptPreview, error) {
	if !canReviewReceipts(role) {
		return ReceiptPreview{}, ErrReviewCaseForbidden
	}
	if strings.TrimSpace(reviewID) == "" {
		return ReceiptPreview{}, ErrInvalidReviewCase
	}
	reviewCase, err := service.reviews.GetReceiptCase(ctx, reviewID)
	if err != nil {
		return ReceiptPreview{}, err
	}
	receipt, err := service.receipts.FindByID(ctx, reviewCase.ReceiptID)
	if errors.Is(err, ErrReceiptNotFound) {
		return ReceiptPreview{}, ErrReceiptPreviewUnavailable
	}
	if err != nil {
		return ReceiptPreview{}, fmt.Errorf("find receipt for preview: %w", err)
	}
	url, expiresAt, err := service.objects.CreateDownloadURL(ctx, receipt.ObjectKey)
	if err != nil {
		return ReceiptPreview{}, fmt.Errorf("create receipt preview URL: %w", ErrReceiptPreviewUnavailable)
	}
	return ReceiptPreview{URL: url, ExpiresAt: expiresAt}, nil
}
