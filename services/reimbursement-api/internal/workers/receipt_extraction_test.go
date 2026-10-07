package workers

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/events"
)

func TestReceiptWorkerDeduplicatesEventID(t *testing.T) {
	dedupe := &fakeDedupe{}
	extractor := &fakeExtractor{}
	worker := NewReceiptExtractionWorker(dedupe, extractor)
	if err := worker.Handle(context.Background(), "event-1", "receipt-1"); err != nil {
		t.Fatalf("first handle: %v", err)
	}
	if err := worker.Handle(context.Background(), "event-1", "receipt-1"); err != nil {
		t.Fatalf("second handle: %v", err)
	}
	if extractor.calls != 1 {
		t.Fatalf("expected one OCR extraction, got %d", extractor.calls)
	}
}

func TestDecodeReceiptEventRejectsMissingReceiptID(t *testing.T) {
	data, err := json.Marshal(events.EventEnvelope{EventID: "event-1", Payload: json.RawMessage(`{}`)})
	if err != nil { t.Fatalf("encode event: %v", err) }
	if _, _, err := decodeReceiptEvent(data); err == nil { t.Fatal("expected missing receipt id to be rejected") }
}

type fakeDedupe struct{ seen bool }

func (store *fakeDedupe) Seen(context.Context, string) (bool, error) { return store.seen, nil }
func (store *fakeDedupe) MarkSeen(context.Context, string) error     { store.seen = true; return nil }

type fakeExtractor struct{ calls int }

func (extractor *fakeExtractor) Extract(context.Context, string) error { extractor.calls++; return nil }
