package workers

import "context"

type EventDeduplicator interface {
	Seen(context.Context, string) (bool, error)
	MarkSeen(context.Context, string) error
}
type ReceiptExtractor interface {
	Extract(context.Context, string) error
}
type ReceiptExtractionWorker struct {
	dedupe    EventDeduplicator
	extractor ReceiptExtractor
}

func NewReceiptExtractionWorker(dedupe EventDeduplicator, extractor ReceiptExtractor) *ReceiptExtractionWorker {
	return &ReceiptExtractionWorker{dedupe: dedupe, extractor: extractor}
}
func (worker *ReceiptExtractionWorker) Handle(ctx context.Context, eventID string, receiptID string) error {
	seen, err := worker.dedupe.Seen(ctx, eventID)
	if err != nil || seen {
		return err
	}
	if err = worker.extractor.Extract(ctx, receiptID); err != nil {
		return err
	}
	return worker.dedupe.MarkSeen(ctx, eventID)
}

func (worker *ReceiptExtractionWorker) MarkHandled(ctx context.Context, eventID string) error {
	return worker.dedupe.MarkSeen(ctx, eventID)
}
