package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

const (
	MaxReceiptSizeBytes int64 = 20 * 1024 * 1024
	MaxPDFPages               = 20
)

var (
	ErrInvalidReceiptType        = errors.New("unsupported receipt content type")
	ErrInvalidReceiptSize        = errors.New("receipt size exceeds limit")
	ErrInvalidFileSignature      = errors.New("receipt file signature does not match content type")
	ErrUnsafeReceiptFile         = errors.New("receipt file is unsafe")
	ErrDuplicateReceiptContent   = errors.New("receipt content was already uploaded")
	ErrDuplicateSubmittedInvoice = errors.New("invoice number already exists on a submitted claim")
	ErrReceiptNotFound           = errors.New("receipt not found")
)

type CreateUploadSessionCommand struct {
	Filename    string
	ContentType string
	SizeBytes   int64
}

type UploadSession struct {
	ReceiptID string
	ObjectKey string
	UploadURL string
}

type StoredObject struct {
	ContentType string
	Content     []byte
}

type ObjectStore interface {
	CreateUploadURL(context.Context, string, string, int64) (string, error)
	ReadObject(context.Context, string) (StoredObject, error)
}

type FileScanner interface {
	Scan(context.Context, []byte) (bool, error)
}

type OCRResult struct {
	InvoiceNumber string
	Confidence    float64
}

type OCRClient interface {
	Extract(context.Context, StoredObject) (OCRResult, error)
}

type ClaimReader interface {
	FindOwned(context.Context, string, string) (domain.Claim, error)
}

type ReceiptRepository interface {
	Create(context.Context, domain.Receipt) error
	FindOwned(context.Context, string, string, string) (domain.Receipt, error)
	FindByContentHash(context.Context, string) (domain.Receipt, error)
	MarkReadyForOCR(context.Context, string, string) error
	MarkReviewRequired(context.Context, string, string) error
	MarkExtracted(context.Context, string, OCRResult) error
	HasSubmittedInvoice(context.Context, string) (bool, error)
}

type ReceiptService struct {
	claims     ClaimReader
	repository ReceiptRepository
	objects    ObjectStore
	scanner    FileScanner
	ocr        OCRClient
	ids        IDGenerator
}

func NewReceiptService(claims ClaimReader, repository ReceiptRepository, objects ObjectStore, scanner FileScanner, ocr OCRClient, ids IDGenerator) *ReceiptService {
	return &ReceiptService{claims: claims, repository: repository, objects: objects, scanner: scanner, ocr: ocr, ids: ids}
}

func (service *ReceiptService) CreateUploadSession(ctx context.Context, actorID string, claimID string, command CreateUploadSessionCommand) (UploadSession, error) {
	if err := validateUploadMetadata(command); err != nil {
		return UploadSession{}, err
	}
	claim, err := service.claims.FindOwned(ctx, claimID, actorID)
	if errors.Is(err, ErrClaimNotFound) {
		return UploadSession{}, ErrClaimNotFound
	}
	if err != nil {
		return UploadSession{}, fmt.Errorf("find claim for receipt: %w", err)
	}
	if claim.Status != domain.ClaimStatusDraft {
		return UploadSession{}, domain.ErrClaimNotDraft
	}
	receiptID := service.ids.Next()
	objectKey := "receipts/" + receiptID
	uploadURL, err := service.objects.CreateUploadURL(ctx, objectKey, command.ContentType, command.SizeBytes)
	if err != nil {
		return UploadSession{}, fmt.Errorf("create upload url: %w", err)
	}
	receipt := domain.Receipt{ID: receiptID, ClaimID: claimID, OwnerID: actorID, Filename: command.Filename, ContentType: command.ContentType, ExpectedSize: command.SizeBytes, ObjectKey: objectKey, Status: domain.ReceiptStatusUploadPending, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
	if err := service.repository.Create(ctx, receipt); err != nil {
		return UploadSession{}, fmt.Errorf("create receipt: %w", err)
	}
	return UploadSession{ReceiptID: receiptID, ObjectKey: objectKey, UploadURL: uploadURL}, nil
}

func (service *ReceiptService) FinalizeReceiptUpload(ctx context.Context, actorID string, claimID string, receiptID string) error {
	receipt, err := service.repository.FindOwned(ctx, receiptID, claimID, actorID)
	if errors.Is(err, ErrReceiptNotFound) {
		return ErrReceiptNotFound
	}
	if err != nil {
		return fmt.Errorf("find receipt: %w", err)
	}
	object, err := service.objects.ReadObject(ctx, receipt.ObjectKey)
	if err != nil {
		return fmt.Errorf("read receipt object: %w", err)
	}
	if int64(len(object.Content)) > MaxReceiptSizeBytes || (receipt.ExpectedSize > 0 && int64(len(object.Content)) > receipt.ExpectedSize) {
		return ErrInvalidReceiptSize
	}
	if object.ContentType != receipt.ContentType || !hasValidSignature(receipt.ContentType, object.Content) {
		return ErrInvalidFileSignature
	}
	unsafe, err := service.scanner.Scan(ctx, object.Content)
	if err != nil {
		return fmt.Errorf("scan receipt: %w", err)
	}
	if unsafe {
		if err := service.repository.MarkReviewRequired(ctx, receipt.ID, "MALWARE_DETECTED"); err != nil {
			return fmt.Errorf("quarantine unsafe receipt: %w", err)
		}
		return ErrUnsafeReceiptFile
	}
	hash := contentHash(object.Content)
	existing, err := service.repository.FindByContentHash(ctx, hash)
	if err == nil && existing.ID != receipt.ID {
		if err := service.repository.MarkReviewRequired(ctx, receipt.ID, "DUPLICATE_CONTENT"); err != nil {
			return fmt.Errorf("flag duplicate receipt: %w", err)
		}
		return ErrDuplicateReceiptContent
	}
	if err != nil && !errors.Is(err, ErrReceiptNotFound) {
		return fmt.Errorf("find duplicate receipt: %w", err)
	}
	if err := service.repository.MarkReadyForOCR(ctx, receipt.ID, hash); err != nil {
		return fmt.Errorf("mark receipt ready for ocr: %w", err)
	}
	return nil
}

func (service *ReceiptService) ExtractReceipt(ctx context.Context, actorID string, claimID string, receiptID string) error {
	receipt, err := service.repository.FindOwned(ctx, receiptID, claimID, actorID)
	if errors.Is(err, ErrReceiptNotFound) {
		return ErrReceiptNotFound
	}
	if err != nil {
		return fmt.Errorf("find receipt: %w", err)
	}
	object, err := service.objects.ReadObject(ctx, receipt.ObjectKey)
	if err != nil {
		return fmt.Errorf("read receipt object: %w", err)
	}
	result, err := service.ocr.Extract(ctx, object)
	if err != nil {
		return fmt.Errorf("extract receipt: %w", err)
	}
	if result.InvoiceNumber != "" {
		exists, err := service.repository.HasSubmittedInvoice(ctx, result.InvoiceNumber)
		if err != nil {
			return fmt.Errorf("check submitted invoice: %w", err)
		}
		if exists {
			if err := service.repository.MarkReviewRequired(ctx, receipt.ID, "DUPLICATE_SUBMITTED_INVOICE"); err != nil {
				return fmt.Errorf("flag duplicate invoice: %w", err)
			}
			return ErrDuplicateSubmittedInvoice
		}
	}
	if err := service.repository.MarkExtracted(ctx, receipt.ID, result); err != nil {
		return fmt.Errorf("persist ocr result: %w", err)
	}
	return nil
}

func validateUploadMetadata(command CreateUploadSessionCommand) error {
	if strings.TrimSpace(command.Filename) == "" || command.SizeBytes <= 0 || command.SizeBytes > MaxReceiptSizeBytes {
		return ErrInvalidReceiptSize
	}
	switch command.ContentType {
	case "image/jpeg", "image/png", "application/pdf":
		return nil
	default:
		return ErrInvalidReceiptType
	}
}

func hasValidSignature(contentType string, content []byte) bool {
	switch contentType {
	case "image/jpeg":
		return len(content) >= 3 && bytes.Equal(content[:3], []byte{0xff, 0xd8, 0xff})
	case "image/png":
		return len(content) >= 8 && bytes.Equal(content[:8], []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a})
	case "application/pdf":
		pageCount := bytes.Count(content, []byte("/Type /Page"))
		return len(content) >= 5 && bytes.Equal(content[:5], []byte("%PDF-")) && pageCount > 0 && pageCount <= MaxPDFPages
	default:
		return false
	}
}

func contentHash(content []byte) string {
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}
