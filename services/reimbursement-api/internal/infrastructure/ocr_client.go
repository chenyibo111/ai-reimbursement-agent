package infrastructure

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strings"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
)

type HTTPReceiptOCRClient struct {
	baseURL string
	client  *http.Client
}

func NewHTTPReceiptOCRClient(baseURL string) *HTTPReceiptOCRClient {
	return &HTTPReceiptOCRClient{baseURL: strings.TrimRight(baseURL, "/"), client: &http.Client{Timeout: 2 * time.Minute}}
}

func (client *HTTPReceiptOCRClient) ValidatePDF(ctx context.Context, object application.StoredObject) (int, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	partHeader := textproto.MIMEHeader{}
	partHeader.Set("Content-Disposition", `form-data; name="file"; filename="receipt.pdf"`)
	partHeader.Set("Content-Type", object.ContentType)
	part, err := writer.CreatePart(partHeader)
	if err != nil {
		return 0, fmt.Errorf("create PDF validation multipart: %w", err)
	}
	if _, err = part.Write(object.Content); err != nil {
		return 0, fmt.Errorf("write PDF validation content: %w", err)
	}
	if err = writer.Close(); err != nil {
		return 0, fmt.Errorf("close PDF validation multipart: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.baseURL+"/pdf-info", &body)
	if err != nil {
		return 0, fmt.Errorf("build PDF validation request: %w", err)
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := client.client.Do(request)
	if err != nil {
		return 0, fmt.Errorf("request PDF validation: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 && response.StatusCode < 500 {
		return 0, application.ErrInvalidFileSignature
	}
	if response.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("PDF validation service returned status %d", response.StatusCode)
	}
	var result struct {
		Pages int `json:"pages"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1024)).Decode(&result); err != nil {
		return 0, fmt.Errorf("decode PDF validation response: %w", err)
	}
	return result.Pages, nil
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
	fullText := text.String()
	result := parseOCRReceipt(fullText, confidence)
	result.Text = boundedOCRText(fullText)
	return result, nil
}

func boundedOCRText(value string) string {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\x00", ""))
	runes := []rune(value)
	if len(runes) > 8_000 {
		runes = runes[:8_000]
	}
	return string(runes)
}
