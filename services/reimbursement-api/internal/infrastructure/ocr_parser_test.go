package infrastructure

import "testing"

func TestParseOCRReceiptExtractsLabelledInvoiceMetadata(t *testing.T) {
	result := parseOCRReceipt(`
发票号码：26317000001513684420
开票日期：2026年05月01日
价税合计（小写）￥101.55
销售方名称：上海象鲜网络科技有限公司
`, 0.96)

	if result.InvoiceNumber != "26317000001513684420" {
		t.Fatalf("invoice number = %q", result.InvoiceNumber)
	}
	if result.InvoiceDate == nil || result.InvoiceDate.Format("2006-01-02") != "2026-05-01" {
		t.Fatalf("invoice date = %#v, want 2026-05-01", result.InvoiceDate)
	}
	if result.TotalAmountCent == nil || *result.TotalAmountCent != 10155 {
		t.Fatalf("total amount = %#v, want 10155 cents", result.TotalAmountCent)
	}
	if result.SellerName == nil || *result.SellerName != "上海象鲜网络科技有限公司" {
		t.Fatalf("seller name = %#v", result.SellerName)
	}
	if result.Confidence != 0.96 {
		t.Fatalf("confidence = %v, want 0.96", result.Confidence)
	}
}

func TestParseOCRReceiptKeepsZeroAmountDistinctFromMissingMetadata(t *testing.T) {
	zero := parseOCRReceipt("价税合计（小写）：￥0.00", 0.8)
	if zero.TotalAmountCent == nil || *zero.TotalAmountCent != 0 {
		t.Fatalf("zero amount = %#v, want non-nil 0", zero.TotalAmountCent)
	}

	missing := parseOCRReceipt("2026-05-01\n101.55\n上海象鲜网络科技有限公司\n￥1.234", 0.8)
	if missing.InvoiceDate != nil || missing.TotalAmountCent != nil || missing.SellerName != nil {
		t.Fatalf("unlabelled metadata must remain empty: %#v", missing)
	}
}
