package infrastructure

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestMinIOStorePresignsBrowserUploadsWithPublicEndpoint(t *testing.T) {
	publicServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Query().Get("location") != "" {
			t.Fatalf("expected bucket-location request, got %s %s", request.Method, request.URL.String())
		}
		response.Header().Set("content-type", "application/xml")
		_, _ = fmt.Fprint(response, `<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">us-east-1</LocationConstraint>`)
	}))
	defer publicServer.Close()

	publicURL, err := url.Parse(publicServer.URL)
	if err != nil {
		t.Fatalf("parse public server URL: %v", err)
	}
	store, err := NewMinIOStore("minio:9000", publicURL.Host, "access-key", "secret-key", false, false, "receipts")
	if err != nil {
		t.Fatalf("new minio store: %v", err)
	}

	rawURL, err := store.CreateUploadURL(context.Background(), "receipts/receipt-1", "application/pdf", 42)
	if err != nil {
		t.Fatalf("create upload URL: %v", err)
	}
	uploadURL, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse upload URL: %v", err)
	}
	if uploadURL.Host != publicURL.Host {
		t.Fatalf("expected public upload host %q, got %q", publicURL.Host, uploadURL.Host)
	}
	if strings.Contains(rawURL, "minio:9000") {
		t.Fatalf("expected upload URL not to expose private host: %s", rawURL)
	}
}

func TestMinIOStorePresignsWithoutServerAccessToBrowserPublicEndpoint(t *testing.T) {
	store, err := NewMinIOStore("minio:9000", "localhost:9000", "access-key", "secret-key", false, false, "receipts")
	if err != nil {
		t.Fatalf("new minio store: %v", err)
	}

	rawURL, err := store.CreateUploadURL(context.Background(), "receipts/receipt-1", "application/pdf", 42)
	if err != nil {
		t.Fatalf("create upload URL without reaching the browser endpoint: %v", err)
	}
	if !strings.HasPrefix(rawURL, "http://localhost:9000/") {
		t.Fatalf("expected browser public URL, got %s", rawURL)
	}
}
