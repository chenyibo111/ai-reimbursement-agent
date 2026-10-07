package infrastructure

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"regexp"
	"strings"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
)

var invoiceNumberPattern = regexp.MustCompile(`(?m)(?:发票号码|发票号)\s*[：:]?\s*([A-Za-z0-9-]{6,})`)

type HTTPReceiptOCRClient struct {
	baseURL string
	client  *http.Client
}

func NewHTTPReceiptOCRClient(baseURL string) *HTTPReceiptOCRClient {
	return &HTTPReceiptOCRClient{baseURL: strings.TrimRight(baseURL, "/"), client: &http.Client{Timeout: 2 * time.Minute}}
}

func (client *HTTPReceiptOCRClient) Extract(ctx context.Context, object application.StoredObject) (application.OCRResult, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	partHeader := textproto.MIMEHeader{}
	partHeader.Set("Content-Disposition", `form-data; name="file"; filename="receipt"`)
	partHeader.Set("Content-Type", object.ContentType)
	part, err := writer.CreatePart(partHeader)
	if err != nil {
		return application.OCRResult{}, fmt.Errorf("create ocr multipart: %w", err)
	}
	if _, err = part.Write(object.Content); err != nil {
		return application.OCRResult{}, fmt.Errorf("write ocr content: %w", err)
	}
	if err = writer.Close(); err != nil {
		return application.OCRResult{}, fmt.Errorf("close ocr multipart: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.baseURL+"/extract", &body)
	if err != nil {
		return application.OCRResult{}, fmt.Errorf("build ocr request: %w", err)
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := client.client.Do(request)
	if err != nil {
		return application.OCRResult{}, fmt.Errorf("request ocr: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return application.OCRResult{}, fmt.Errorf("ocr service returned status %d", response.StatusCode)
	}
	var payload struct {
		Pages []struct {
			Text       string  `json:"text"`
			Confidence float64 `json:"confidence"`
		} `json:"pages"`
	}
	if err = json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return application.OCRResult{}, fmt.Errorf("decode ocr response: %w", err)
	}
	var text strings.Builder
	var confidence float64
	for _, page := range payload.Pages {
		text.WriteString(page.Text)
		text.WriteByte('\n')
		confidence += page.Confidence
	}
	if len(payload.Pages) > 0 {
		confidence /= float64(len(payload.Pages))
	}
	result := application.OCRResult{Confidence: confidence}
	if match := invoiceNumberPattern.FindStringSubmatch(text.String()); len(match) == 2 {
		result.InvoiceNumber = match[1]
	}
	return result, nil
}
