package events

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/nats-io/nats.go"
)

const (
	ReimbursementStreamName  = "REIMBURSEMENT"
	ReimbursementEventMaxAge = 7 * 24 * time.Hour
)

// JetStreamPublisher owns one NATS connection and persists events in the
// REIMBURSEMENT stream before acknowledging publication to the Outbox store.
type JetStreamPublisher struct {
	connection *nats.Conn
	stream     nats.JetStreamContext
}

func NewJetStreamPublisher(serverURL string) (*JetStreamPublisher, error) {
	connection, err := nats.Connect(strings.TrimSpace(serverURL), nats.Name("reimbursement-outbox-publisher"))
	if err != nil {
		return nil, fmt.Errorf("connect nats: %w", err)
	}
	stream, err := connection.JetStream()
	if err != nil {
		connection.Close()
		return nil, fmt.Errorf("create jetstream context: %w", err)
	}
	if err := ensureReimbursementStream(stream); err != nil {
		connection.Close()
		return nil, err
	}
	return &JetStreamPublisher{connection: connection, stream: stream}, nil
}

func (publisher *JetStreamPublisher) Close() {
	if publisher != nil && publisher.connection != nil {
		publisher.connection.Close()
	}
}

func (publisher *JetStreamPublisher) JetStream() nats.JetStreamContext {
	return publisher.stream
}

func (publisher *JetStreamPublisher) Publish(ctx context.Context, subject string, event OutboxEvent) error {
	payload, err := encodeEnvelope(event)
	if err != nil {
		return fmt.Errorf("encode event envelope: %w", err)
	}
	if _, err := publisher.stream.Publish(subject, payload, nats.MsgId(event.ID), nats.Context(ctx)); err != nil {
		return fmt.Errorf("publish event: %w", err)
	}
	return nil
}

func ensureReimbursementStream(stream nats.JetStreamContext) error {
	if _, err := stream.StreamInfo(ReimbursementStreamName); err == nil {
		return nil
	}
	if _, err := stream.AddStream(&nats.StreamConfig{
		Name:      ReimbursementStreamName,
		Subjects:  []string{"reimbursement.>"},
		Retention: nats.LimitsPolicy,
		MaxAge:    ReimbursementEventMaxAge,
		MaxBytes:  512 * 1024 * 1024,
		Storage:   nats.FileStorage,
		Discard:   nats.DiscardOld,
	}); err != nil {
		if _, infoErr := stream.StreamInfo(ReimbursementStreamName); infoErr == nil {
			return nil
		}
		return fmt.Errorf("create reimbursement stream: %w", err)
	}
	return nil
}
