package application

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

const DefaultLowOCRConfidenceThreshold = 0.70

type ReceiptReviewConfig struct {
	LowOCRConfidenceThreshold float64           `json:"lowOcrConfidenceThreshold"`
	ReasonLabels              map[string]string `json:"reasonLabels,omitempty"`
}

type ReceiptReviewConfigReader interface {
	GetActive(context.Context, string) (domain.ConfigSnapshot, error)
}

var configurableReviewReasons = map[string]bool{
	"OCR_LOW_CONFIDENCE": true, "OCR_RETRY_EXHAUSTED": true,
	"DUPLICATE_CONTENT": true, "DUPLICATE_SUBMITTED_INVOICE": true,
	"LEGACY_REVIEW_REQUIRED": true,
}

func ValidateReceiptReviewConfigPayload(payload json.RawMessage) error {
	_, err := decodeReceiptReviewConfig(payload)
	return err
}

func decodeReceiptReviewConfig(payload json.RawMessage) (ReceiptReviewConfig, error) {
	var config ReceiptReviewConfig
	if bytes.Equal(bytes.TrimSpace(payload), []byte("null")) {
		return config, ErrConfigInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return config, fmt.Errorf("%w: decode receipt review config: %v", ErrConfigInvalid, err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return config, ErrConfigInvalid
	}
	if config.LowOCRConfidenceThreshold < DefaultLowOCRConfidenceThreshold || config.LowOCRConfidenceThreshold > 0.95 {
		return config, fmt.Errorf("%w: low OCR confidence threshold must be between 0.70 and 0.95", ErrConfigInvalid)
	}
	for reason, label := range config.ReasonLabels {
		if !configurableReviewReasons[reason] || label == "" || strings.TrimSpace(label) != label || len([]rune(label)) > 100 {
			return config, fmt.Errorf("%w: invalid review reason label", ErrConfigInvalid)
		}
	}
	return config, nil
}
