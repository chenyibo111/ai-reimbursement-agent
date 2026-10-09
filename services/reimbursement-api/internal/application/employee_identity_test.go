package application

import (
	"context"
	"testing"
)

func TestEmployeeIdentityServiceUpsertsValidatedIdentity(t *testing.T) {
	repository := &MemoryEmployeeIdentityRepository{}
	service := NewEmployeeIdentityService(repository)
	command := EmployeeIdentityCommand{EmployeeID: "employee-1", DisplayName: "飞书员工", FeishuOpenID: "ou-employee", Role: "EMPLOYEE", IsActive: true}
	if err := service.Upsert(context.Background(), command); err != nil {
		t.Fatal(err)
	}
	if repository.Last != command {
		t.Fatalf("stored = %#v", repository.Last)
	}
	if err := service.Upsert(context.Background(), EmployeeIdentityCommand{EmployeeID: "employee-1", DisplayName: "", FeishuOpenID: "ou-employee", Role: "EMPLOYEE", IsActive: true}); err == nil {
		t.Fatal("expected invalid employee rejection")
	}
	if err := service.Upsert(context.Background(), EmployeeIdentityCommand{EmployeeID: "employee-1", DisplayName: "飞书员工", FeishuOpenID: "ou-employee", Role: "UNKNOWN", IsActive: true}); err == nil {
		t.Fatal("expected invalid role rejection")
	}
}
