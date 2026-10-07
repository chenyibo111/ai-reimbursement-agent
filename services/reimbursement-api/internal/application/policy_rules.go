package application

import (
	"context"
	"fmt"
)

type PolicyStatus string
const ( PolicyStatusDraft PolicyStatus = "DRAFT"; PolicyStatusPublished PolicyStatus = "PUBLISHED"; PolicyStatusArchived PolicyStatus = "ARCHIVED" )
type PolicyVersion struct { ID string; EffectiveDate string; Status PolicyStatus }
type MemoryPolicyRuleRepository struct { Versions map[string]PolicyVersion }
func NewMemoryPolicyRuleRepository() *MemoryPolicyRuleRepository { return &MemoryPolicyRuleRepository{Versions: map[string]PolicyVersion{}} }
type PolicyRuleRepository interface { Publish(context.Context, string, PolicyVersion) error }
func (repository *MemoryPolicyRuleRepository) Publish(_ context.Context, _ string, version PolicyVersion) error { for id, current := range repository.Versions { if current.Status == PolicyStatusPublished { current.Status = PolicyStatusArchived; repository.Versions[id] = current } }; version.Status=PolicyStatusPublished; repository.Versions[version.ID]=version; return nil }
type PolicyRuleService struct { repository PolicyRuleRepository }
func NewPolicyRuleService(repository PolicyRuleRepository) *PolicyRuleService { return &PolicyRuleService{repository} }
func (service *PolicyRuleService) Publish(actorID string, version PolicyVersion) error { if actorID == "" || version.ID == "" || version.EffectiveDate == "" { return fmt.Errorf("invalid policy publish") }; return service.repository.Publish(context.Background(), actorID, version) }
