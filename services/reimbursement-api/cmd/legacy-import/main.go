package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

type exportRecord struct { Claim struct { ID string `json:"id"`; EmployeeID string `json:"employeeId"`; Status string `json:"status"`; Purpose *string `json:"purpose"`; Version int64 `json:"version"` } `json:"claim"`; Submissions []struct { SubmissionNumber string `json:"submissionNumber"` } `json:"submissions"` }

func main() {
	url := os.Getenv("REIMBURSEMENT_DATABASE_URL"); if url == "" { panic("REIMBURSEMENT_DATABASE_URL is required") }
	pool, err := pgxpool.New(context.Background(), url); if err != nil { panic(err) }; defer pool.Close()
	service := application.NewLegacyImportService(store.NewPostgresLegacyImportRepository(pool)); scanner := bufio.NewScanner(os.Stdin)
	inserted, skipped := 0, 0
	for scanner.Scan() { var row exportRecord; if err := json.Unmarshal(scanner.Bytes(), &row); err != nil { panic(err) }; purpose := "历史迁移"; if row.Claim.Purpose != nil { purpose = *row.Claim.Purpose }; number := ""; if len(row.Submissions)>0 { number=row.Submissions[0].SubmissionNumber }; result, err := service.Import(context.Background(), application.LegacyClaimImport{Claim: application.LegacyClaim(row.Claim.ID, row.Claim.EmployeeID, row.Claim.Status, purpose, row.Claim.Version), SubmissionNumber:number}); if err != nil { panic(err) }; inserted += result.Inserted; skipped += result.Skipped }
	if err := scanner.Err(); err != nil { panic(err) }; fmt.Fprintf(os.Stderr, "legacy import: inserted=%d skipped=%d\n", inserted, skipped)
}
