package application

import (
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
	"testing"
)

func TestEvaluatePolicyRulesEnforcesOnlySupportedClaimFields(t *testing.T) {
	amount := int64(12000)
	claim := domain.Claim{RequestedAmountCent: &amount, ExpenseCategory: "住宿", ProjectCode: ""}
	policy := PolicyVersion{ID: "policy-2", EffectiveDate: "2026-10-01", Rules: []PolicyRule{
		{Code: "TOTAL", Name: "整单限额", Type: "CLAIM_TOTAL_MAX", Severity: "BLOCKING", Config: []byte(`{"maxAmountCents":10000}`)},
		{Code: "PROJECT", Name: "住宿项目", Type: "CATEGORY_REQUIRED_FIELD", Severity: "WARNING", Config: []byte(`{"category":"住宿","field":"projectCode"}`)},
	}}
	issues, err := EvaluatePolicyRules(policy, claim)
	if err != nil || len(issues) != 2 || issues[0].Code != "POLICY_TOTAL" || !issues[0].Blocking || issues[1].Code != "POLICY_PROJECT" || issues[1].Blocking {
		t.Fatalf("issues=%#v err=%v", issues, err)
	}
}

func TestCategoryRulesRejectMissingCategoryAndBlankParticipants(t *testing.T) {
	policy := PolicyVersion{ID: "policy-3", EffectiveDate: "2026-10-01", Rules: []PolicyRule{
		{Code: "ALLOWED", Name: "允许类别", Type: "CATEGORY_ALLOWED", Severity: "BLOCKING", Config: []byte(`{"categories":["住宿"]}`)},
		{Code: "PEOPLE", Name: "住宿同行人", Type: "CATEGORY_REQUIRED_FIELD", Severity: "BLOCKING", Config: []byte(`{"category":"住宿","field":"participants"}`)},
	}}
	missing, err := EvaluatePolicyRules(policy, domain.Claim{})
	if err != nil || len(missing) != 1 || missing[0].Code != "POLICY_ALLOWED" {
		t.Fatalf("missing category issues=%#v err=%v", missing, err)
	}
	blank, err := EvaluatePolicyRules(policy, domain.Claim{ExpenseCategory: "住宿", Participants: []string{"  "}})
	if err != nil || len(blank) != 1 || blank[0].Code != "POLICY_PEOPLE" {
		t.Fatalf("blank participant issues=%#v err=%v", blank, err)
	}
}

func TestValidatePolicyRejectsUnrepresentableItemLimit(t *testing.T) {
	policy := PolicyVersion{ID: "policy-2", EffectiveDate: "2026-10-01", Rules: []PolicyRule{{Code: "ITEM", Name: "单笔限额", Type: "CATEGORY_ITEM_MAX", Severity: "BLOCKING", Config: []byte(`{"category":"住宿","maxAmountCents":10000}`)}}}
	if err := ValidatePolicyVersion(policy); err == nil {
		t.Fatal("expected unsupported item-level rule to be rejected")
	}
}

func TestPolicyPublishRejectsBaselineIdentifierAndNormalizesEmptyRules(t *testing.T) {
	repository := NewMemoryPolicyRuleRepository()
	service := NewPolicyRuleService(repository)
	if err := service.Publish("admin-1", PolicyVersion{ID: "baseline-v1", EffectiveDate: "2026-10-01"}); err == nil {
		t.Fatal("baseline identifier must be reserved")
	}
	if err := service.Publish("admin-1", PolicyVersion{ID: "empty-version", EffectiveDate: "2026-10-01"}); err != nil {
		t.Fatal(err)
	}
	if repository.Versions["empty-version"].Rules == nil {
		t.Fatal("empty rules should serialize as []")
	}
}

func TestPublishPolicy_PreservesEarlierEffectiveVersion(t *testing.T) {
	repository := NewMemoryPolicyRuleRepository()
	service := NewPolicyRuleService(repository)
	if err := service.Publish("admin-1", PolicyVersion{ID: "v1", EffectiveDate: "2026-10-01"}); err != nil {
		t.Fatal(err)
	}
	if err := service.Publish("admin-1", PolicyVersion{ID: "v2", EffectiveDate: "2026-11-01"}); err != nil {
		t.Fatal(err)
	}
	if repository.Versions["v1"].Status != PolicyStatusPublished || repository.Versions["v2"].Status != PolicyStatusPublished {
		t.Fatalf("unexpected versions: %#v", repository.Versions)
	}
}
