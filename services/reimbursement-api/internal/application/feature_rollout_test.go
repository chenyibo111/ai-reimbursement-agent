package application

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

func TestFeatureRolloutRejectsUntrustedDepartmentAndInvalidTargets(t *testing.T) {
	for _, payload := range []string{
		`{"mode":"DEPARTMENTS","departmentIds":["sales"]}`,
		`{"mode":"EMPLOYEES","employeeIds":[""]}`,
		`{"mode":"PERCENT","percent":101,"salt":"release-1"}`,
		`{"mode":"PERCENT","percent":1}`,
	} {
		if err := ValidateFeatureRolloutPayload(json.RawMessage(payload)); err == nil {
			t.Fatalf("accepted invalid rollout: %s", payload)
		}
	}
}

type rolloutEmployeeLookup struct{}

func (rolloutEmployeeLookup) ActiveEmployeeExists(_ context.Context, id string) (bool, error) {
	return id == "employee-1", nil
}

func TestFeatureRolloutRejectsUnknownEmployeeBeforePublication(t *testing.T) {
	if err := ValidateFeatureRolloutEmployees(context.Background(), json.RawMessage(`{"mode":"EMPLOYEES","employeeIds":["missing"]}`), rolloutEmployeeLookup{}); err == nil {
		t.Fatal("accepted an employee ID that is not active")
	}
	if err := ValidateFeatureRolloutEmployees(context.Background(), json.RawMessage(`{"mode":"EMPLOYEES","employeeIds":["employee-1"]}`), rolloutEmployeeLookup{}); err != nil {
		t.Fatalf("rejected active employee: %v", err)
	}
}

func TestFeatureRolloutIsStableAcrossInstances(t *testing.T) {
	config := FeatureRollout{Mode: "PERCENT", Percent: 1, Salt: "release-1"}
	first := IsEnabledForEmployee(config, "employee-42", "")
	for i := 0; i < 10; i++ {
		if IsEnabledForEmployee(config, "employee-42", "") != first {
			t.Fatal("same employee moved between rollout cohorts")
		}
	}
	if IsEnabledForEmployee(FeatureRollout{Mode: "OFF"}, "employee-42", "") || !IsEnabledForEmployee(FeatureRollout{Mode: "ALL"}, "employee-42", "") {
		t.Fatal("OFF/ALL rollout boundary changed")
	}
}

type rolloutSnapshotReader struct {
	snapshot domain.ConfigSnapshot
	err      error
}

func (reader *rolloutSnapshotReader) GetActive(context.Context, string) (domain.ConfigSnapshot, error) {
	return reader.snapshot, reader.err
}

func TestCreateClaimUsesPublishedRolloutBeforeLegacyEmployeeList(t *testing.T) {
	service := newClaimServiceForTest(NewMemoryClaimRepository())
	service.SetItemizedEmployeeIDs([]string{"employee-1"})
	reader := &rolloutSnapshotReader{snapshot: domain.ConfigSnapshot{Domain: "feature_rollout", Version: 7, Payload: json.RawMessage(`{"mode":"EMPLOYEES","employeeIds":["employee-2"]}`)}}
	service.SetFeatureRolloutReader(reader)
	first, err := service.CreateClaim(context.Background(), "employee-1", CreateClaimCommand{})
	if err != nil || first.ItemizationMode != domain.ClaimItemizationModeLegacy {
		t.Fatalf("published list did not override environment: %#v %v", first, err)
	}
	second, err := service.CreateClaim(context.Background(), "employee-2", CreateClaimCommand{})
	if err != nil || second.ItemizationMode != domain.ClaimItemizationModeItemized || second.ItemizationRolloutVersion != 7 {
		t.Fatalf("published list not applied to new draft: %#v %v", second, err)
	}
	reader.snapshot = domain.ConfigSnapshot{Domain: "feature_rollout", Version: 8, Payload: json.RawMessage(`{"mode":"OFF"}`)}
	third, err := service.CreateClaim(context.Background(), "employee-2", CreateClaimCommand{})
	if err != nil || third.ItemizationMode != domain.ClaimItemizationModeLegacy || second.ItemizationMode != domain.ClaimItemizationModeItemized {
		t.Fatalf("rollout change rewrote an old draft or failed to affect a new one: old=%#v new=%#v %v", second, third, err)
	}
}

func TestCreateClaimDoesNotFallBackToEnvironmentOnRolloutReadFailure(t *testing.T) {
	service := newClaimServiceForTest(NewMemoryClaimRepository())
	service.SetItemizedEmployeeIDs([]string{"employee-1"})
	service.SetFeatureRolloutReader(&rolloutSnapshotReader{err: errors.New("database unavailable")})
	if _, err := service.CreateClaim(context.Background(), "employee-1", CreateClaimCommand{}); err == nil {
		t.Fatal("created draft using stale environment rollout after active read failed")
	}
}

func TestCreateClaimUsesLastPublishedRolloutWhenRepositoryTemporarilyFails(t *testing.T) {
	service := newClaimServiceForTest(NewMemoryClaimRepository())
	service.SetItemizedEmployeeIDs([]string{"employee-1"})
	reader := &rolloutSnapshotReader{snapshot: domain.ConfigSnapshot{Version: 4, Payload: json.RawMessage(`{"mode":"EMPLOYEES","employeeIds":["employee-2"]}`)}}
	service.SetFeatureRolloutReader(reader)
	if _, err := service.CreateClaim(context.Background(), "employee-2", CreateClaimCommand{}); err != nil {
		t.Fatal(err)
	}
	reader.err = errors.New("temporary database error")
	claim, err := service.CreateClaim(context.Background(), "employee-2", CreateClaimCommand{})
	if err != nil || claim.ItemizationMode != domain.ClaimItemizationModeItemized || claim.ItemizationRolloutVersion != 4 {
		t.Fatalf("cached published rollout was lost: %#v %v", claim, err)
	}
	other, err := service.CreateClaim(context.Background(), "employee-1", CreateClaimCommand{})
	if err != nil || other.ItemizationMode != domain.ClaimItemizationModeLegacy {
		t.Fatalf("environment override leaked through cached rollout: %#v %v", other, err)
	}
}
