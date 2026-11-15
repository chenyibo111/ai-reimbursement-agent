package application

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

type receiptReviewPreviewRepository struct{ ConfigRepository }

func (receiptReviewPreviewRepository) GetDraft(context.Context, string) (domain.ConfigDraft, error) {
	return domain.ConfigDraft{Domain: "receipt_review", Revision: 2, Payload: json.RawMessage(`{"lowOcrConfidenceThreshold":0.8}`)}, nil
}
func (receiptReviewPreviewRepository) GetActive(context.Context, string) (domain.ConfigSnapshot, error) {
	return domain.ConfigSnapshot{Domain: "receipt_review", Version: 1, Payload: json.RawMessage(`{"lowOcrConfidenceThreshold":0.7}`)}, nil
}

type receiptReviewSamples struct{}

func (receiptReviewSamples) RecentOCRConfidences(context.Context, int) ([]float64, error) {
	return []float64{0.65, 0.75, 0.90}, nil
}

func TestReceiptReviewImpactPreviewsOnlyChangedSampleDecisions(t *testing.T) {
	service := NewConfigService(receiptReviewPreviewRepository{})
	service.RegisterValidator("receipt_review", ValidateReceiptReviewConfigPayload)
	service.SetReceiptReviewSampleReader(receiptReviewSamples{})
	impact, err := service.PreviewReceiptReviewImpact(context.Background(), 2)
	if err != nil || impact.RecentSampleCount != 3 || impact.NewReviewCount != 1 || impact.ReducedReviewCount != 0 {
		t.Fatalf("impact=%+v err=%v", impact, err)
	}
}

func TestReceiptReviewConfigRejectsUnsafeThresholdAndUnknownReason(t *testing.T) {
	for _, payload := range []string{
		`{"lowOcrConfidenceThreshold":0.69}`,
		`{"lowOcrConfidenceThreshold":0.96}`,
		`{"lowOcrConfidenceThreshold":0.8,"reasonLabels":{"UNRECOGNIZED":"跳过复核"}}`,
		`null`,
	} {
		if err := ValidateReceiptReviewConfigPayload(json.RawMessage(payload)); err == nil {
			t.Fatalf("accepted invalid review config: %s", payload)
		}
	}
	if err := ValidateReceiptReviewConfigPayload(json.RawMessage(`{"lowOcrConfidenceThreshold":0.8,"reasonLabels":{"OCR_LOW_CONFIDENCE":"识别信息需要核对"}}`)); err != nil {
		t.Fatalf("valid review config rejected: %v", err)
	}
}
