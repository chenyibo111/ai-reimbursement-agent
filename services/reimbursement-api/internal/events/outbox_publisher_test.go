package events

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestOutboxPublisherRetriesAndMarksPublishedOnce(t *testing.T) {
	store := &fakeOutboxStore{events: []OutboxEvent{{ID: "event-1", Type: "claim.submitted.v1", LeaseToken: "lease-1"}}}
	publisher := &fakePublisher{failures: 1}
	service := NewOutboxPublisher(store, publisher)
	if err := service.PublishBatch(context.Background(), 10); err != nil {
		t.Fatalf("first publish batch: %v", err)
	}
	if store.published != 0 || store.failed != 1 || store.failureLease != "lease-1" {
		t.Fatalf("expected failure recorded with its lease, got published=%d failed=%d lease=%q", store.published, store.failed, store.failureLease)
	}
	if err := service.PublishBatch(context.Background(), 10); err != nil {
		t.Fatalf("retry batch: %v", err)
	}
	if store.published != 1 || publisher.calls != 2 || store.publishedLease != "lease-1" {
		t.Fatalf("expected one publish after retry with its lease, published=%d calls=%d lease=%q", store.published, publisher.calls, store.publishedLease)
	}
}

func TestEventEnvelopePreservesOutboxMetadata(t *testing.T) {
	occurredAt := time.Date(2026, 10, 7, 8, 0, 0, 0, time.UTC)
	payload := []byte(`{"receiptId":"receipt-1"}`)
	encoded, err := encodeEnvelope(OutboxEvent{ID: "event-3", Type: "ReceiptReadyForOCR", AggregateID: "receipt-1", OccurredAt: occurredAt, Payload: payload})
	if err != nil {
		t.Fatalf("encode envelope: %v", err)
	}
	var envelope EventEnvelope
	if err := json.Unmarshal(encoded, &envelope); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	if envelope.EventID != "event-3" || envelope.EventType != "ReceiptReadyForOCR" || envelope.AggregateID != "receipt-1" || !envelope.OccurredAt.Equal(occurredAt) {
		t.Fatalf("event metadata lost: %+v", envelope)
	}
	if string(envelope.Payload) != string(payload) {
		t.Fatalf("payload changed: %s", envelope.Payload)
	}
}

func TestOutboxPublisherPublishesEventEnvelopeToDomainSubject(t *testing.T) {
	store := &fakeOutboxStore{events: []OutboxEvent{{ID: "event-2", Type: "ReceiptReadyForOCR", AggregateID: "receipt-1", LeaseToken: "lease-2"}}}
	publisher := &fakePublisher{}
	service := NewOutboxPublisher(store, publisher)

	if err := service.PublishBatch(context.Background(), 10); err != nil {
		t.Fatalf("publish batch: %v", err)
	}
	if publisher.event.ID != "event-2" || publisher.event.AggregateID != "receipt-1" {
		t.Fatalf("expected complete event envelope, got %+v", publisher.event)
	}
	if publisher.subject != "reimbursement.receipt.ready_for_ocr.v1" {
		t.Fatalf("unexpected subject %q", publisher.subject)
	}
}

type fakeOutboxStore struct {
	events                       []OutboxEvent
	published, failed            int
	publishedLease, failureLease string
}

func (store *fakeOutboxStore) Claim(context.Context, int) ([]OutboxEvent, error) {
	return store.events, nil
}
func (store *fakeOutboxStore) MarkPublished(_ context.Context, _ string, leaseToken string) error {
	store.published++
	store.publishedLease = leaseToken
	return nil
}
func (store *fakeOutboxStore) MarkFailed(_ context.Context, _ string, leaseToken string) error {
	store.failed++
	store.failureLease = leaseToken
	return nil
}

type fakePublisher struct {
	failures, calls int
	event           OutboxEvent
	subject         string
}

func (publisher *fakePublisher) Publish(_ context.Context, subject string, event OutboxEvent) error {
	publisher.calls++
	publisher.event = event
	publisher.subject = subject
	if publisher.failures > 0 {
		publisher.failures--
		return errors.New("nats unavailable")
	}
	return nil
}
