package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	employeeID := flag.String("employee-id", "", "owner employee ID")
	claimID := flag.String("claim-id", "", "owned draft ID")
	expectedVersion := flag.Int64("expected-version", 0, "version shown by the dry run")
	apply := flag.Bool("apply", false, "convert the reviewed draft")
	flag.Parse()
	if err := run(*employeeID, *claimID, *expectedVersion, *apply); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(employeeID, claimID string, expectedVersion int64, apply bool) error {
	if strings.TrimSpace(employeeID) == "" || strings.TrimSpace(claimID) == "" || (apply && expectedVersion < 1) {
		return fmt.Errorf("--employee-id and --claim-id are required; --apply also requires --expected-version from the dry run")
	}
	databaseURL := strings.TrimSpace(os.Getenv("REIMBURSEMENT_DATABASE_URL"))
	if databaseURL == "" {
		return fmt.Errorf("REIMBURSEMENT_DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		return err
	}
	claim, err := store.NewPostgresClaimRepository(pool).FindOwned(ctx, claimID, employeeID)
	if err != nil {
		return err
	}
	if claim.Status != domain.ClaimStatusDraft {
		return domain.ErrClaimNotDraft
	}
	receipts, err := store.NewPostgresReceiptRepository(pool).ListOwnedByClaim(ctx, claimID, employeeID)
	if err != nil {
		return err
	}
	extracted := 0
	for _, receipt := range receipts {
		if receipt.Status == domain.ReceiptStatusExtracted {
			extracted++
		}
	}
	if !apply {
		fmt.Printf("claim=%s mode=%s version=%d receipts=%d extracted=%d; no changes applied\n", claim.ClaimNumber, claim.ItemizationMode, claim.Version, len(receipts), extracted)
		return nil
	}
	if err := store.NewPostgresExpenseItemRepository(pool).ConvertOwnedDraft(ctx, employeeID, claimID, expectedVersion); err != nil {
		return err
	}
	fmt.Printf("claim=%s converted to ITEMIZED; re-read the workbench before proceeding\n", claim.ClaimNumber)
	return nil
}
