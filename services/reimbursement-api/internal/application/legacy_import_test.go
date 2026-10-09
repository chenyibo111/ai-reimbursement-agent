package application

import (
	"context"
	"testing"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

func TestLegacyImport_PreservesClaimAndSubmissionIdentifiers(t *testing.T) {
	repository := NewMemoryLegacyImportRepository()
	service := NewLegacyImportService(repository)
	result, err := service.Import(context.Background(), LegacyClaimImport{Claim: domain.Claim{ID: "legacy-claim-1", OwnerID: "employee-1", Status: domain.ClaimStatusSubmitted, Purpose: "客户拜访", Version: 3}, SubmissionNumber: "BX-2026-001"})
	if err != nil { t.Fatalf("import: %v", err) }
	if result.Inserted != 1 { t.Fatalf("inserted = %d", result.Inserted) }
	stored := repository.Claims["legacy-claim-1"]
	if stored.Claim.ID != "legacy-claim-1" || stored.SubmissionNumber != "BX-2026-001" { t.Fatalf("identifiers not preserved: %#v", stored) }
}

func TestLegacyImport_IsIdempotent(t *testing.T) {
	repository := NewMemoryLegacyImportRepository()
	service := NewLegacyImportService(repository)
	record := LegacyClaimImport{Claim: domain.Claim{ID: "legacy-claim-1", OwnerID: "employee-1", Status: domain.ClaimStatusDraft, Purpose: "出差", Version: 1}}
	if _, err := service.Import(context.Background(), record); err != nil { t.Fatal(err) }
	result, err := service.Import(context.Background(), record)
	if err != nil { t.Fatal(err) }
	if result.Skipped != 1 || len(repository.Claims) != 1 { t.Fatalf("expected idempotent skip: %#v", result) }
}

func TestReconcile_ReportsMissingReceiptHashAndStatusMismatch(t *testing.T) {
	report := ReconcileLegacyClaim(LegacyClaimImport{Claim: domain.Claim{ID: "c1", Status: domain.ClaimStatusSubmitted}, SubmissionNumber: "BX-1"}, LegacyClaimImport{Claim: domain.Claim{ID: "c1", Status: domain.ClaimStatusDraft}, SubmissionNumber: "BX-1"}, []string{"legacy-hash"}, []string{})
	if len(report.Differences) != 2 { t.Fatalf("differences = %#v", report.Differences) }
}
