package application

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

func LegacyClaim(id, ownerID, status, purpose string, version int64) domain.Claim { return domain.Claim{ID:id, OwnerID:ownerID, Status:domain.ClaimStatus(status), Purpose:purpose, Version:version} }

// LegacyClaimImport is a validated, read-only export record from the legacy system.
// IDs are supplied by the source and must never be regenerated during a cutover.
type LegacyClaimImport struct {
	Claim            domain.Claim
	SubmissionNumber string
}

type LegacyImportResult struct { Inserted, Skipped int }

type ReconciliationReport struct { Differences []string }

func ReconcileLegacyClaim(source LegacyClaimImport, target LegacyClaimImport, sourceHashes []string, targetHashes []string) ReconciliationReport {
	differences := []string{}
	if source.Claim.Status != target.Claim.Status { differences = append(differences, "claim status mismatch") }
	if source.SubmissionNumber != target.SubmissionNumber { differences = append(differences, "submission number mismatch") }
	seen := map[string]bool{}
	for _, hash := range targetHashes { seen[hash] = true }
	for _, hash := range sourceHashes { if !seen[hash] { differences = append(differences, "missing receipt hash") } }
	return ReconciliationReport{Differences: differences}
}

type LegacyImportRepository interface { InsertIfAbsent(context.Context, LegacyClaimImport) (bool, error) }

type LegacyImportService struct { repository LegacyImportRepository }

func NewLegacyImportService(repository LegacyImportRepository) *LegacyImportService { return &LegacyImportService{repository: repository} }

func (service *LegacyImportService) Import(ctx context.Context, record LegacyClaimImport) (LegacyImportResult, error) {
	if strings.TrimSpace(record.Claim.ID) == "" || strings.TrimSpace(record.Claim.OwnerID) == "" || strings.TrimSpace(record.Claim.Purpose) == "" { return LegacyImportResult{}, fmt.Errorf("invalid legacy claim") }
	inserted, err := service.repository.InsertIfAbsent(ctx, record)
	if err != nil { return LegacyImportResult{}, fmt.Errorf("import legacy claim %s: %w", record.Claim.ID, err) }
	if inserted { return LegacyImportResult{Inserted: 1}, nil }
	return LegacyImportResult{Skipped: 1}, nil
}

type MemoryLegacyImportRepository struct { mu sync.Mutex; Claims map[string]LegacyClaimImport }
func NewMemoryLegacyImportRepository() *MemoryLegacyImportRepository { return &MemoryLegacyImportRepository{Claims: map[string]LegacyClaimImport{}} }
func (repository *MemoryLegacyImportRepository) InsertIfAbsent(_ context.Context, record LegacyClaimImport) (bool, error) {
	repository.mu.Lock(); defer repository.mu.Unlock()
	if _, exists := repository.Claims[record.Claim.ID]; exists { return false, nil }
	repository.Claims[record.Claim.ID] = record
	return true, nil
}
