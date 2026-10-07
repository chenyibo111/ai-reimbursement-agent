package application

import "testing"

func TestPublishPolicy_ArchivesPriorVersionAtomically(t *testing.T) {
	repository := NewMemoryPolicyRuleRepository()
	service := NewPolicyRuleService(repository)
	if err := service.Publish("admin-1", PolicyVersion{ID: "v1", EffectiveDate: "2026-10-01"}); err != nil { t.Fatal(err) }
	if err := service.Publish("admin-1", PolicyVersion{ID: "v2", EffectiveDate: "2026-11-01"}); err != nil { t.Fatal(err) }
	if repository.Versions["v1"].Status != PolicyStatusArchived || repository.Versions["v2"].Status != PolicyStatusPublished { t.Fatalf("unexpected versions: %#v", repository.Versions) }
}
