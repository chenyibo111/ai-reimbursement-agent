package application

import "testing"

func TestResolveReviewCase_RequiresFinanceReviewer(t *testing.T) {
	repository := NewMemoryReviewCaseRepository(ReviewCase{ID: "r1", Status: ReviewCaseOpen})
	service := NewReviewCaseService(repository)
	if err := service.Resolve("employee-1", "EMPLOYEE", "r1", "确认票据字段"); err == nil { t.Fatal("expected forbidden") }
	if err := service.Resolve("finance-1", "FINANCE_REVIEWER", "r1", "确认票据字段"); err != nil { t.Fatal(err) }
}
