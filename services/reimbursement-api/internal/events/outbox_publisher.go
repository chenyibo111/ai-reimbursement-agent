package events

import (
	"context"
	"strings"
	"time"
)

type OutboxEvent struct {
	ID, Type, AggregateID, LeaseToken string
	Payload                           []byte
	OccurredAt                        time.Time
}

type Publisher interface {
	Publish(context.Context, string, OutboxEvent) error
}
type OutboxStore interface {
	Claim(context.Context, int) ([]OutboxEvent, error)
	MarkPublished(context.Context, string, string) error
	MarkFailed(context.Context, string, string) error
}
type OutboxPublisher struct {
	store     OutboxStore
	publisher Publisher
}

func NewOutboxPublisher(store OutboxStore, publisher Publisher) *OutboxPublisher {
	return &OutboxPublisher{store: store, publisher: publisher}
}
func (service *OutboxPublisher) PublishBatch(ctx context.Context, limit int) error {
	events, err := service.store.Claim(ctx, limit)
	if err != nil {
		return err
	}
	for _, event := range events {
		if err := service.publisher.Publish(ctx, subject(event.Type), event); err != nil {
			_ = service.store.MarkFailed(ctx, event.ID, event.LeaseToken)
			continue
		}
		if err := service.store.MarkPublished(ctx, event.ID, event.LeaseToken); err != nil {
			return err
		}
	}
	return nil
}

func subject(eventType string) string {
	switch eventType {
	case "ClaimCreated":
		return "reimbursement.claim.created.v1"
	case "ClaimUpdated":
		return "reimbursement.claim.updated.v1"
	case "ClaimDeleted":
		return "reimbursement.claim.deleted.v1"
	case "ClaimSubmitted":
		return "reimbursement.claim.submitted.v1"
	case "ReceiptUploadSessionCreated":
		return "reimbursement.receipt.upload_session_created.v1"
	case "ReceiptReadyForOCR":
		return "reimbursement.receipt.ready_for_ocr.v1"
	case "ReceiptExtractionCompleted":
		return "reimbursement.receipt.extraction_completed.v1"
	case "ReceiptReviewRequired":
		return "reimbursement.receipt.review_required.v1"
	default:
		return "reimbursement.event." + strings.ToLower(strings.TrimSpace(eventType)) + ".v1"
	}
}
