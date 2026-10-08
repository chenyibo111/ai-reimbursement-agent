package main

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/events"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/infrastructure"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/store"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/workers"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	databaseURL := strings.TrimSpace(os.Getenv("REIMBURSEMENT_DATABASE_URL"))
	if databaseURL == "" {
		log.Fatal("REIMBURSEMENT_DATABASE_URL is required")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Fatalf("connect reimbursement database: %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("ping reimbursement database: %v", err)
	}
	objects, err := minIOFromEnvironment()
	if err != nil {
		log.Fatalf("configure object storage: %v", err)
	}
	clamAddress := strings.TrimSpace(os.Getenv("CLAMAV_HOST")) + ":" + strings.TrimSpace(os.Getenv("CLAMAV_PORT"))
	if strings.HasPrefix(clamAddress, ":") || strings.HasSuffix(clamAddress, ":") {
		log.Fatal("CLAMAV_HOST and CLAMAV_PORT are required")
	}
	ocrURL := strings.TrimSpace(os.Getenv("OCR_SERVICE_URL"))
	if ocrURL == "" {
		log.Fatal("OCR_SERVICE_URL is required")
	}
	publisher, err := events.NewJetStreamPublisher(natsURL())
	if err != nil {
		log.Fatalf("configure nats publisher: %v", err)
	}
	defer publisher.Close()

	claimRepository := store.NewPostgresClaimRepository(pool)
	receipts := store.NewPostgresReceiptRepository(pool)
	receiptService := application.NewReceiptService(
		claimRepository, receipts, objects,
		infrastructure.NewClamAVScanner(clamAddress), infrastructure.NewHTTPReceiptOCRClient(ocrURL),
		application.SecureIDGenerator{}, claimRepository,
	)
	receiptWorker := workers.NewReceiptExtractionWorker(
		events.NewPostgresEventDeduplicator(pool, workers.ReceiptOCRConsumer),
		workers.NewApplicationReceiptExtractor(receipts, receiptService),
	)
	go publishOutbox(ctx, events.NewOutboxPublisher(events.NewPostgresOutboxStore(pool), publisher))
	log.Print("reimbursement worker started")
	if err := workers.ConsumeReceiptReady(ctx, publisher.JetStream(), receiptWorker, receipts); err != nil {
		log.Printf("reimbursement worker stopped with error: %v", err)
		os.Exit(1)
	}
}

func publishOutbox(ctx context.Context, publisher *events.OutboxPublisher) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		if err := publisher.PublishBatch(ctx, 25); err != nil {
			log.Printf("outbox publish batch failed: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func natsURL() string {
	if value := strings.TrimSpace(os.Getenv("NATS_URL")); value != "" {
		return value
	}
	return "nats://nats:4222"
}

func minIOFromEnvironment() (*infrastructure.MinIOStore, error) {
	rawEndpoint := strings.TrimSpace(os.Getenv("S3_ENDPOINT"))
	parsed, err := url.Parse(rawEndpoint)
	if err != nil || parsed.Host == "" {
		return nil, fmt.Errorf("S3_ENDPOINT must be an http(s) URL")
	}
	bucket := strings.TrimSpace(os.Getenv("S3_BUCKET"))
	accessKey := strings.TrimSpace(os.Getenv("S3_ACCESS_KEY_ID"))
	secretKey := strings.TrimSpace(os.Getenv("S3_SECRET_ACCESS_KEY"))
	if bucket == "" || accessKey == "" || secretKey == "" {
		return nil, fmt.Errorf("S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required")
	}
	return infrastructure.NewMinIOStore(parsed.Host, accessKey, secretKey, parsed.Scheme == "https", bucket)
}
