package domain

import "time"

type ReceiptStatus string

const (
	ReceiptStatusUploadPending ReceiptStatus = "UPLOAD_PENDING"
	ReceiptStatusReadyForOCR   ReceiptStatus = "READY_FOR_OCR"
	ReceiptStatusExtracted     ReceiptStatus = "EXTRACTED"
	ReceiptStatusReview        ReceiptStatus = "REVIEW_REQUIRED"
	ReceiptStatusQuarantined   ReceiptStatus = "QUARANTINED"
)

type Receipt struct {
	ID              string
	ClaimID         string
	OwnerID         string
	Filename        string
	ContentType     string
	ExpectedSize    int64
	ObjectKey       string
	ContentHash     string
	Status          ReceiptStatus
	InvoiceNumber   string
	InvoiceDate     *time.Time
	TotalAmountCent *int64
	SellerName      *string
	OCRConfidence   float64
	// ClosedByReview distinguishes a finance decision to exclude a receipt
	// from a malware/security quarantine, which shares the QUARANTINED status.
	ClosedByReview bool
	CreatedAt      time.Time
	UpdatedAt      time.Time
}
