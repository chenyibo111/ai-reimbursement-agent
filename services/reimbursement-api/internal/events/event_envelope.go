package events

import (
	"encoding/json"
	"time"
)

// EventEnvelope is the stable wire format sent to every NATS consumer.
type EventEnvelope struct {
	EventID     string          `json:"event_id"`
	EventType   string          `json:"event_type"`
	OccurredAt  time.Time       `json:"occurred_at"`
	AggregateID string          `json:"aggregate_id"`
	Payload     json.RawMessage `json:"payload"`
}

func encodeEnvelope(event OutboxEvent) ([]byte, error) {
	return json.Marshal(EventEnvelope{
		EventID:     event.ID,
		EventType:   event.Type,
		OccurredAt:  event.OccurredAt,
		AggregateID: event.AggregateID,
		Payload:     json.RawMessage(event.Payload),
	})
}
