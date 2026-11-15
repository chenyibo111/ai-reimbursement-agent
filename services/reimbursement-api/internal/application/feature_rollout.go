package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

type FeatureRollout struct {
	Mode          string   `json:"mode"`
	EmployeeIDs   []string `json:"employeeIds,omitempty"`
	DepartmentIDs []string `json:"departmentIds,omitempty"`
	Percent       int      `json:"percent,omitempty"`
	Salt          string   `json:"salt,omitempty"`
}

type FeatureRolloutSnapshotReader interface {
	GetActive(context.Context, string) (domain.ConfigSnapshot, error)
}

type FeatureRolloutEmployeeLookup interface {
	ActiveEmployeeExists(context.Context, string) (bool, error)
}

func ValidateFeatureRolloutPayload(payload json.RawMessage) error {
	_, err := decodeFeatureRollout(payload)
	return err
}

func decodeFeatureRollout(payload json.RawMessage) (FeatureRollout, error) {
	var config FeatureRollout
	if bytes.Equal(bytes.TrimSpace(payload), []byte("null")) {
		return config, ErrConfigInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return config, fmt.Errorf("%w: decode feature rollout: %v", ErrConfigInvalid, err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return config, ErrConfigInvalid
	}
	if config.Percent < 0 || config.Percent > 100 || len(config.Salt) > 128 || len(config.EmployeeIDs) > 1000 {
		return config, ErrConfigInvalid
	}
	seen := map[string]bool{}
	for _, id := range config.EmployeeIDs {
		if id == "" || strings.TrimSpace(id) != id || len(id) > 128 || seen[id] {
			return config, ErrConfigInvalid
		}
		seen[id] = true
	}
	switch config.Mode {
	case "OFF", "ALL":
		if len(config.EmployeeIDs) != 0 || len(config.DepartmentIDs) != 0 || config.Percent != 0 || config.Salt != "" {
			return config, ErrConfigInvalid
		}
	case "EMPLOYEES":
		if len(config.EmployeeIDs) == 0 || len(config.DepartmentIDs) != 0 || config.Percent != 0 || config.Salt != "" {
			return config, ErrConfigInvalid
		}
	case "PERCENT":
		if len(config.EmployeeIDs) != 0 || len(config.DepartmentIDs) != 0 || strings.TrimSpace(config.Salt) == "" {
			return config, ErrConfigInvalid
		}
	case "DEPARTMENTS":
		return config, fmt.Errorf("%w: trusted department directory is unavailable", ErrConfigInvalid)
	default:
		return config, ErrConfigInvalid
	}
	return config, nil
}

func ValidateFeatureRolloutEmployees(ctx context.Context, payload json.RawMessage, lookup FeatureRolloutEmployeeLookup) error {
	config, err := decodeFeatureRollout(payload)
	if err != nil {
		return err
	}
	for _, id := range config.EmployeeIDs {
		exists, err := lookup.ActiveEmployeeExists(ctx, id)
		if err != nil {
			return fmt.Errorf("check rollout employee %s: %w", id, err)
		}
		if !exists {
			return fmt.Errorf("%w: employee %s is not active", ErrConfigInvalid, id)
		}
	}
	return nil
}

func IsEnabledForEmployee(config FeatureRollout, employeeID, verifiedDepartmentID string) bool {
	switch config.Mode {
	case "ALL":
		return true
	case "EMPLOYEES":
		for _, id := range config.EmployeeIDs {
			if id == employeeID {
				return true
			}
		}
	case "DEPARTMENTS":
		if verifiedDepartmentID == "" {
			return false
		}
		for _, id := range config.DepartmentIDs {
			if id == verifiedDepartmentID {
				return true
			}
		}
	case "PERCENT":
		if employeeID == "" || config.Percent <= 0 {
			return false
		}
		hash := sha256.Sum256([]byte("itemized:" + employeeID + ":" + config.Salt))
		return binary.BigEndian.Uint64(hash[:8])%10000 < uint64(config.Percent*100)
	}
	return false
}
