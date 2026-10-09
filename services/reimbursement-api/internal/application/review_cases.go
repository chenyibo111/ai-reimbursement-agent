package application

import ( "context"; "fmt" )

type ReviewCaseStatus string
const ( ReviewCaseOpen ReviewCaseStatus = "OPEN"; ReviewCaseResolved ReviewCaseStatus = "RESOLVED" )
type ReviewCase struct { ID string; Status ReviewCaseStatus; Resolution string; ResolvedBy string }
type MemoryReviewCaseRepository struct { Cases map[string]ReviewCase }
func NewMemoryReviewCaseRepository(cases ...ReviewCase) *MemoryReviewCaseRepository { r:=&MemoryReviewCaseRepository{Cases:map[string]ReviewCase{}}; for _, c:=range cases { r.Cases[c.ID]=c }; return r }
type ReviewCaseRepository interface { Resolve(context.Context, string, string, string) error }
func (repository *MemoryReviewCaseRepository) Resolve(_ context.Context, actorID, caseID, resolution string) error { current, ok:=repository.Cases[caseID]; if !ok || current.Status != ReviewCaseOpen { return fmt.Errorf("review case unavailable") }; current.Status=ReviewCaseResolved; current.Resolution=resolution; current.ResolvedBy=actorID; repository.Cases[caseID]=current; return nil }
type ReviewCaseService struct { repository ReviewCaseRepository }
func NewReviewCaseService(repository ReviewCaseRepository) *ReviewCaseService { return &ReviewCaseService{repository} }
func (service *ReviewCaseService) Resolve(actorID, role, caseID, resolution string) error { if role != "FINANCE_REVIEWER" && role != "ADMIN" { return fmt.Errorf("forbidden") }; return service.repository.Resolve(context.Background(), actorID, caseID, resolution) }
