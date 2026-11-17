package application

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

type FormOptions struct {
	CategoryHelpText string `json:"categoryHelpText"`
	ProjectCodeMode  string `json:"projectCodeMode"`
	ProjectCodes     []struct {
		Code    string `json:"code"`
		Label   string `json:"label"`
		Enabled bool   `json:"enabled"`
	} `json:"projectCodes"`
	FieldOrder []string `json:"fieldOrder"`
}

var formFieldIDs = map[string]bool{
	"purpose": true, "expenseCategory": true, "projectCode": true,
	"participants": true, "requestedAmountCent": true, "currency": true, "remark": true,
}

func ValidateFormOptionsPayload(payload json.RawMessage) error {
	if bytes.Equal(bytes.TrimSpace(payload), []byte("null")) {
		return ErrConfigInvalid
	}
	var options FormOptions
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&options); err != nil {
		return fmt.Errorf("%w: decode form options: %v", ErrConfigInvalid, err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return ErrConfigInvalid
	}
	if len([]rune(options.CategoryHelpText)) > 200 || strings.TrimSpace(options.CategoryHelpText) != options.CategoryHelpText {
		return fmt.Errorf("%w: categoryHelpText", ErrConfigInvalid)
	}
	// The reimbursement service has no authoritative project directory yet.
	if (options.ProjectCodeMode != "" && options.ProjectCodeMode != "FREE_TEXT") || len(options.ProjectCodes) != 0 {
		return fmt.Errorf("%w: projectCodeMode requires an authoritative project directory", ErrConfigInvalid)
	}
	seen := make(map[string]bool, len(options.FieldOrder))
	for _, field := range options.FieldOrder {
		if !formFieldIDs[field] || seen[field] {
			return fmt.Errorf("%w: fieldOrder contains an unknown or duplicate field", ErrConfigInvalid)
		}
		seen[field] = true
	}
	if len(options.FieldOrder) != 0 && len(options.FieldOrder) != len(formFieldIDs) {
		return fmt.Errorf("%w: fieldOrder must include every existing field", ErrConfigInvalid)
	}
	return nil
}
