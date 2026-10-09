package application

import (
	"context"
	"fmt"
	"strings"
)

type EmployeeIdentityCommand struct {
	EmployeeID   string
	DisplayName  string
	FeishuOpenID string
	Role         string
	IsActive     bool
}

type EmployeeIdentityRepository interface {
	UpsertEmployeeIdentity(context.Context, EmployeeIdentityCommand) error
}
type EmployeeIdentityService struct{ repository EmployeeIdentityRepository }

func NewEmployeeIdentityService(repository EmployeeIdentityRepository) *EmployeeIdentityService {
	return &EmployeeIdentityService{repository: repository}
}
func (service *EmployeeIdentityService) Upsert(ctx context.Context, command EmployeeIdentityCommand) error {
	if strings.TrimSpace(command.EmployeeID) == "" || strings.TrimSpace(command.DisplayName) == "" || strings.TrimSpace(command.FeishuOpenID) == "" || !employeeIdentityRole(command.Role) {
		return fmt.Errorf("invalid employee identity")
	}
	if err := service.repository.UpsertEmployeeIdentity(ctx, command); err != nil {
		return fmt.Errorf("upsert employee identity: %w", err)
	}
	return nil
}
func employeeIdentityRole(role string) bool {
	return role == "EMPLOYEE" || role == "FINANCE_REVIEWER" || role == "ADMIN"
}

type MemoryEmployeeIdentityRepository struct{ Last EmployeeIdentityCommand }

func (repository *MemoryEmployeeIdentityRepository) UpsertEmployeeIdentity(_ context.Context, command EmployeeIdentityCommand) error {
	repository.Last = command
	return nil
}
