package application

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

func testExpenseCatalog() ExpenseCatalog {
	return ExpenseCatalog{
		Categories: []Category{
			{Code: "LOCAL_TRANSPORT", Label: "市内交通费", Enabled: true},
			{Code: "DINING", Label: "餐饮费", Enabled: true},
			{Code: "LODGING", Label: "住宿费", Enabled: true},
			{Code: "TRANSPORT", Label: "交通费", Enabled: true},
			{Code: "OTHER", Label: "其他", Enabled: true},
		},
		Mappings: []ReceiptMapping{
			{ReceiptType: "TAXI", CategoryCode: "LOCAL_TRANSPORT", PurposeTemplate: "市内出行打车费"},
			{ReceiptType: "DINING", CategoryCode: "DINING", PurposeTemplate: "餐饮费用"},
			{ReceiptType: "LODGING", CategoryCode: "LODGING", PurposeTemplate: "住宿费用"},
			{ReceiptType: "TRANSPORT", CategoryCode: "TRANSPORT", PurposeTemplate: "交通出行费用"},
			{ReceiptType: "OTHER", CategoryCode: "OTHER", PurposeTemplate: "其他费用"},
		},
	}
}

func TestExpenseCatalogRejectsInvalidMappings(t *testing.T) {
	for _, fixture := range []struct {
		name   string
		change func(*ExpenseCatalog)
	}{
		{"duplicate code", func(c *ExpenseCatalog) { c.Categories[1].Code = "LOCAL_TRANSPORT" }},
		{"disabled category", func(c *ExpenseCatalog) { c.Categories[0].Enabled = false }},
		{"missing mapping", func(c *ExpenseCatalog) { c.Mappings = c.Mappings[:4] }},
		{"unknown category", func(c *ExpenseCatalog) { c.Mappings[0].CategoryCode = "MISSING" }},
		{"duplicate type", func(c *ExpenseCatalog) { c.Mappings[1].ReceiptType = "TAXI" }},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			catalog := testExpenseCatalog()
			fixture.change(&catalog)
			if issues := ValidateExpenseCatalog(catalog); len(issues) == 0 {
				t.Fatal("invalid catalog accepted")
			}
		})
	}
}

func TestExpenseCatalogPayloadRejectsUnknownFields(t *testing.T) {
	payload, _ := json.Marshal(testExpenseCatalog())
	var value map[string]any
	if err := json.Unmarshal(payload, &value); err != nil {
		t.Fatal(err)
	}
	value["arbitrary"] = true
	invalid, _ := json.Marshal(value)
	if err := ValidateExpenseCatalogPayload(invalid); err == nil {
		t.Fatal("unknown field accepted")
	}
}

func TestResolveClassificationUsesCatalogIndependentOfPolicy(t *testing.T) {
	catalog := testExpenseCatalog()
	taxi := ResolveClassification("TAXI", "网约车运输服务", "HIGH", "滴滴出行 网约车运输服务", catalog)
	if taxi.ExpenseCategory != "市内交通费" || taxi.Purpose != "市内出行打车费" {
		t.Fatalf("taxi=%+v", taxi)
	}
	other := ResolveClassification("OTHER", "*水果*水果", "HIGH", "电子发票 *水果*水果", catalog)
	if other.ExpenseCategory != "其他" || other.Purpose != "其他费用" {
		t.Fatalf("other=%+v", other)
	}
	unknown := ResolveClassification("TAXI", "不存在", "HIGH", "滴滴出行", catalog)
	if unknown.ReceiptType != ReceiptTypeUnknown || unknown.ExpenseCategory != "" {
		t.Fatalf("unsupported evidence=%+v", unknown)
	}
}

type changingCatalogSnapshotReader struct {
	snapshot domain.ConfigSnapshot
	err      error
}

func (reader *changingCatalogSnapshotReader) GetActive(context.Context, string) (domain.ConfigSnapshot, error) {
	return reader.snapshot, reader.err
}

func TestCachedExpenseCatalogReaderUsesLastCompleteSnapshot(t *testing.T) {
	payload, _ := json.Marshal(testExpenseCatalog())
	source := &changingCatalogSnapshotReader{snapshot: domain.ConfigSnapshot{Domain: "expense_catalog", Version: 7, Payload: payload}}
	reader := NewCachedExpenseCatalogReader(source)
	_, version, err := reader.Load(context.Background())
	if err != nil || version != 7 {
		t.Fatalf("first read version=%d err=%v", version, err)
	}
	source.err = errors.New("database unavailable")
	catalog, version, err := reader.Load(context.Background())
	if err != nil || version != 7 || catalog.Mappings[0].ReceiptType != "TAXI" {
		t.Fatalf("fallback version=%d catalog=%+v err=%v", version, catalog, err)
	}
	newReader := NewCachedExpenseCatalogReader(source)
	if _, _, err := newReader.Load(context.Background()); err == nil {
		t.Fatal("fresh worker accepted a missing active snapshot")
	}
}

type catalogPolicyReader struct{ policy *PolicyVersion }

func (reader catalogPolicyReader) LoadActivePolicy(context.Context, time.Time) (*PolicyVersion, error) {
	return reader.policy, nil
}

func TestExpenseCatalogRejectsCategoryReferencedByActivePolicy(t *testing.T) {
	catalog := testExpenseCatalog()
	catalog.Categories[0].Enabled = false
	catalog.Mappings[0].CategoryCode = "TRANSPORT"
	payload, _ := json.Marshal(catalog)
	policy := &PolicyVersion{Rules: []PolicyRule{{Type: "CATEGORY_ALLOWED", Config: json.RawMessage(`{"categories":["市内交通费","餐饮费"]}`)}}}
	if err := ValidateExpenseCatalogPolicyReferences(context.Background(), payload, catalogPolicyReader{policy}); err == nil {
		t.Fatal("disabled policy category accepted")
	}
}

func TestExpenseCatalogRejectsRenamingLegacyPolicyCategoryEvenWithAlias(t *testing.T) {
	catalog := testExpenseCatalog()
	catalog.Categories[1].Label = "工作餐费"
	catalog.Categories[1].Aliases = []string{"餐饮费"}
	payload, _ := json.Marshal(catalog)
	policy := &PolicyVersion{Rules: []PolicyRule{{Type: "CATEGORY_ALLOWED", Config: json.RawMessage(`{"categories":["餐饮费"]}`)}}}
	if err := ValidateExpenseCatalogPolicyReferences(context.Background(), payload, catalogPolicyReader{policy}); err == nil {
		t.Fatal("legacy name rule cannot match the renamed label through an alias")
	}
}
