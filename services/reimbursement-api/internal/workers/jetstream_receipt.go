package workers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/events"
	"github.com/nats-io/nats.go"
)

const (
	ReceiptReadySubject  = "reimbursement.receipt.ready_for_ocr.v1"
	ReceiptOCRConsumer   = "reimbursement-receipt-ocr-v1"
	ReceiptOCRMaxDeliver = 3
)

type ReceiptReviewMarker interface {
	MarkReviewRequired(context.Context, string, string) error
}

type receiptEventPayload struct {
	ReceiptID string `json:"receiptId"`
}

// ConsumeReceiptReady runs a durable, shared OCR consumer. Transient errors
// receive at most two redeliveries; the third failure becomes a review item.
func ConsumeReceiptReady(ctx context.Context, stream nats.JetStreamContext, worker *ReceiptExtractionWorker, reviews ReceiptReviewMarker) error {
	subscription, err := stream.PullSubscribe(ReceiptReadySubject, ReceiptOCRConsumer,
		nats.BindStream(events.ReimbursementStreamName),
		nats.ManualAck(),
		nats.AckWait(2*time.Minute),
		nats.MaxDeliver(ReceiptOCRMaxDeliver),
	)
	if err != nil {
		return fmt.Errorf("subscribe receipt extraction: %w", err)
	}
	for {
		if err := ctx.Err(); err != nil {
			return nil
		}
		messages, err := subscription.Fetch(1, nats.MaxWait(time.Second))
		if err != nil {
			if errors.Is(err, nats.ErrTimeout) {
				continue
			}
			if errors.Is(err, context.Canceled) || errors.Is(err, nats.ErrConnectionClosed) {
				return nil
			}
			return fmt.Errorf("receive receipt event: %w", err)
		}
		if len(messages) != 1 {
			continue
		}
		if err := processReceiptMessage(ctx, messages[0], worker, reviews); err != nil {
			return err
		}
	}
}

func processReceiptMessage(ctx context.Context, message *nats.Msg, worker *ReceiptExtractionWorker, reviews ReceiptReviewMarker) error {
	envelope, payload, err := decodeReceiptEvent(message.Data)
	if err != nil { return err }
	if err := worker.Handle(ctx, envelope.EventID, payload.ReceiptID); err != nil {
		metadata, metadataErr := message.Metadata()
		if metadataErr != nil {
			return fmt.Errorf("read receipt event metadata: %w", metadataErr)
		}
		if metadata.NumDelivered >= ReceiptOCRMaxDeliver {
			if reviewErr := reviews.MarkReviewRequired(ctx, payload.ReceiptID, "OCR_RETRY_EXHAUSTED"); reviewErr != nil {
				return fmt.Errorf("mark exhausted receipt for review: %w", reviewErr)
			}
			if seenErr := worker.MarkHandled(ctx, envelope.EventID); seenErr != nil {
				return seenErr
			}
			return message.Ack()
		}
		return message.NakWithDelay(time.Second)
	}
	return message.Ack()
}

func decodeReceiptEvent(data []byte) (events.EventEnvelope, receiptEventPayload, error) {
	var envelope events.EventEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return events.EventEnvelope{}, receiptEventPayload{}, fmt.Errorf("decode receipt event envelope: %w", err)
	}
	var payload receiptEventPayload
	if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
		return events.EventEnvelope{}, receiptEventPayload{}, fmt.Errorf("decode receipt event payload: %w", err)
	}
	if strings.TrimSpace(envelope.EventID) == "" || strings.TrimSpace(payload.ReceiptID) == "" {
		return events.EventEnvelope{}, receiptEventPayload{}, errors.New("receipt event must contain event_id and receiptId")
	}
	return envelope, payload, nil
}
