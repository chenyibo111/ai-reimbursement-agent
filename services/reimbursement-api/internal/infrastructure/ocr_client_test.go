package infrastructure

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
)

func TestHTTPReceiptOCRClientPreservesMimeAndExtractsInvoiceNumber(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if err := request.ParseMultipartForm(1024); err != nil {
			t.Fatalf("parse multipart form: %v", err)
		}
		file, header, err := request.FormFile("file")
		if err != nil {
			t.Fatalf("read upload: %v", err)
		}
		defer file.Close()
		if header.Header.Get("Content-Type") != "image/png" {
			t.Fatalf("expected image/png, got %q", header.Header.Get("Content-Type"))
		}
		_ = json.NewEncoder(response).Encode(map[string]any{"pages": []map[string]any{{"text": "发票号码：INV-123456", "confidence": 0.92}}})
	}))
	defer server.Close()

	result, err := NewHTTPReceiptOCRClient(server.URL).Extract(context.Background(), application.StoredObject{ContentType: "image/png", Content: []byte("file")})
	if err != nil {
		t.Fatalf("extract receipt: %v", err)
	}
	if result.InvoiceNumber != "INV-123456" || result.Confidence != 0.92 {
		t.Fatalf("unexpected ocr result: %#v", result)
	}
}
