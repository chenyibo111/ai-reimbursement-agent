package infrastructure

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
)

var (
	invoiceNumberPattern = regexp.MustCompile(`(?m)(?:发票号码|发票号)\s*[：:]?\s*([A-Za-z0-9-]{6,})`)
	invoiceDatePattern   = regexp.MustCompile(`(?m)(?:开票日期|日期)\s*[：:]?\s*((?:19|20)\d{2})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?`)
	totalAmountPattern   = regexp.MustCompile(`(?m)(?:价\s*税\s*合\s*计\s*(?:[（(]\s*小\s*写\s*[）)])?|合\s*计|[（(]\s*小\s*写\s*[）)])\s*[：:]?\s*(?:人民币\s*)?[¥￥]?\s*((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,10})(?:\.[0-9]{1,2})?)(?:\s|$)`)
	sellerNamePattern    = regexp.MustCompile(`(?m)(?:销售方名称|销售方\s*名称)\s*[：:]?\s*([^\r\n]{1,160})`)
)

func parseOCRReceipt(text string, confidence float64) application.OCRResult {
	result := application.OCRResult{Confidence: confidence}
	if match := invoiceNumberPattern.FindStringSubmatch(text); len(match) == 2 {
		result.InvoiceNumber = match[1]
	}
	if match := invoiceDatePattern.FindStringSubmatch(text); len(match) == 4 {
		if parsed, err := time.Parse("2006-01-02", fmt.Sprintf("%s-%02s-%02s", match[1], match[2], match[3])); err == nil {
			result.InvoiceDate = &parsed
		}
	}
	if match := totalAmountPattern.FindStringSubmatch(text); len(match) == 2 {
		if cents, ok := amountCents(match[1]); ok {
			result.TotalAmountCent = &cents
		}
	}
	if match := sellerNamePattern.FindStringSubmatch(text); len(match) == 2 {
		if seller := normalizeSellerName(match[1]); seller != "" {
			result.SellerName = &seller
		}
	}
	return result
}

func amountCents(value string) (int64, bool) {
	value = strings.ReplaceAll(value, ",", "")
	parts := strings.Split(value, ".")
	if len(parts) > 2 || len(parts[0]) == 0 || len(parts[0]) > 10 {
		return 0, false
	}
	whole, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || whole > 9_999_999_999 {
		return 0, false
	}
	decimal := "00"
	if len(parts) == 2 {
		decimal = parts[1] + "0"
		decimal = decimal[:2]
	}
	fraction, err := strconv.ParseInt(decimal, 10, 64)
	if err != nil {
		return 0, false
	}
	return whole*100 + fraction, true
}

func normalizeSellerName(value string) string {
	value = strings.Map(func(character rune) rune {
		if unicode.IsControl(character) {
			return -1
		}
		return character
	}, value)
	value = strings.TrimSpace(value)
	if utf8RuneCount(value) > 160 {
		return ""
	}
	return value
}

func utf8RuneCount(value string) int {
	return len([]rune(value))
}
