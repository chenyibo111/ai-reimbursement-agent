package transport

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

var claimNumberPattern = regexp.MustCompile(`^BX[0-9]{8}-[0-9]{4,}$`)

type claimsHandler struct {
	claims      ClaimService
	submissions SubmissionService
	receipts    ReceiptService
}

func (handler *claimsHandler) listClaims(response http.ResponseWriter, request *http.Request) {
	actor, _ := ActorFromContext(request.Context())
	if _, present := request.URL.Query()["claimNumber"]; present {
		claimNumber := request.URL.Query().Get("claimNumber")
		if !claimNumberPattern.MatchString(claimNumber) {
			writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "报销单号格式无效")
			return
		}
		claim, err := handler.claims.FindClaimByNumber(request.Context(), actor.ID, claimNumber)
		if err == application.ErrClaimNotFound {
			writeJSON(response, http.StatusOK, map[string]any{"items": []any{}})
			return
		}
		if err != nil {
			writeMappedError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"items": []any{claimResponse(claim)}})
		return
	}
	if claimSearchRequested(request) {
		query, err := parseClaimSearchQuery(request)
		if err != nil {
			writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "单据查询条件无效")
			return
		}
		searcher, ok := handler.claims.(interface {
			SearchClaims(context.Context, string, application.SearchClaimsQuery) (application.SearchClaimsPage, error)
		})
		if !ok {
			writeError(response, http.StatusServiceUnavailable, "UNAVAILABLE", "单据查询暂不可用")
			return
		}
		page, err := searcher.SearchClaims(request.Context(), actor.ID, query)
		if errors.Is(err, application.ErrInvalidClaimSearch) {
			writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "单据查询条件无效")
			return
		}
		if err != nil {
			writeMappedError(response, err)
			return
		}
		items := make([]map[string]any, 0, len(page.Items))
		for _, claim := range page.Items {
			items = append(items, claimResponse(claim))
		}
		writeJSON(response, http.StatusOK, map[string]any{"items": items, "totalCount": page.TotalCount, "nextCursor": page.NextCursor})
		return
	}
	limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
	claims, err := handler.claims.ListClaims(request.Context(), actor.ID, limit)
	if err != nil {
		writeMappedError(response, err)
		return
	}
	items := make([]map[string]any, 0, len(claims))
	for _, claim := range claims {
		items = append(items, claimResponse(claim))
	}
	writeJSON(response, http.StatusOK, map[string]any{"items": items})
}

func claimSearchRequested(request *http.Request) bool {
	for _, key := range []string{"search", "status", "createdFrom", "createdBefore", "purposeContains", "expenseCategory", "minRequestedAmountCent", "maxRequestedAmountCent", "sort", "cursor", "countOnly"} {
		if _, exists := request.URL.Query()[key]; exists {
			return true
		}
	}
	return false
}

func parseClaimSearchQuery(request *http.Request) (application.SearchClaimsQuery, error) {
	values := request.URL.Query()
	allowed := map[string]bool{"search": true, "status": true, "createdFrom": true, "createdBefore": true, "purposeContains": true, "expenseCategory": true, "minRequestedAmountCent": true, "maxRequestedAmountCent": true, "sort": true, "limit": true, "cursor": true, "countOnly": true}
	for key, entries := range values {
		if !allowed[key] || len(entries) != 1 {
			return application.SearchClaimsQuery{}, application.ErrInvalidClaimSearch
		}
	}
	query := application.SearchClaimsQuery{Status: values.Get("status"), PurposeContains: strings.TrimSpace(values.Get("purposeContains")), ExpenseCategory: strings.TrimSpace(values.Get("expenseCategory")), Sort: values.Get("sort"), Cursor: values.Get("cursor")}
	if raw := values.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 100 {
			return query, application.ErrInvalidClaimSearch
		}
		query.Limit = limit
	}
	if raw := values.Get("countOnly"); raw != "" {
		if raw != "true" && raw != "false" {
			return query, application.ErrInvalidClaimSearch
		}
		query.CountOnly = raw == "true"
	}
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		return query, err
	}
	for _, item := range []struct {
		name   string
		target *time.Time
	}{{"createdFrom", &query.CreatedFrom}, {"createdBefore", &query.CreatedBefore}} {
		if raw := values.Get(item.name); raw != "" {
			date, err := time.ParseInLocation("2006-01-02", raw, location)
			if err != nil {
				return query, application.ErrInvalidClaimSearch
			}
			*item.target = date.UTC()
		}
	}
	for _, item := range []struct {
		name   string
		target **int64
	}{{"minRequestedAmountCent", &query.MinRequestedAmountCent}, {"maxRequestedAmountCent", &query.MaxRequestedAmountCent}} {
		if raw := values.Get(item.name); raw != "" {
			amount, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || amount < 0 {
				return query, application.ErrInvalidClaimSearch
			}
			*item.target = &amount
		}
	}
	if query.Status != "" && query.Status != "DRAFT" && query.Status != "SUBMITTED" {
		return query, application.ErrInvalidClaimSearch
	}
	if !query.CreatedFrom.IsZero() && !query.CreatedBefore.IsZero() && !query.CreatedFrom.Before(query.CreatedBefore) {
		return query, application.ErrInvalidClaimSearch
	}
	if query.Cursor != "" {
		decoded, err := base64.RawURLEncoding.DecodeString(query.Cursor)
		var cursor map[string]any
		if err != nil || len(decoded) > 500 || json.Unmarshal(decoded, &cursor) != nil || cursor["i"] == nil {
			return query, application.ErrInvalidClaimSearch
		}
	}
	return query, nil
}

func (handler *claimsHandler) createUploadSession(response http.ResponseWriter, request *http.Request) {
	actor, _ := ActorFromContext(request.Context())
	if strings.TrimSpace(request.Header.Get("Idempotency-Key")) == "" {
		writeError(response, http.StatusBadRequest, "IDEMPOTENCY_KEY_REQUIRED", "请提供 Idempotency-Key")
		return
	}
	if handler.receipts == nil {
		writeError(response, http.StatusNotImplemented, "NOT_IMPLEMENTED", "附件服务暂不可用")
		return
	}
	var body struct {
		Filename    string `json:"filename"`
		ContentType string `json:"contentType"`
		SizeBytes   int64  `json:"sizeBytes"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容格式不正确")
		return
	}
	ctx := request.Context()
	if actor.Channel == "agent" {
		ctx = application.WithInternalUploadURL(ctx)
	}
	session, err := handler.receipts.CreateUploadSession(ctx, actor.ID, pathClaimID(request), application.CreateUploadSessionCommand{Filename: body.Filename, ContentType: body.ContentType, SizeBytes: body.SizeBytes})
	if err != nil {
		writeMappedError(response, err)
		return
	}
	// Object keys remain an internal storage detail; the client only gets its receipt ID and signed URL.
	writeJSON(response, http.StatusCreated, map[string]any{"receiptId": session.ReceiptID, "uploadUrl": session.UploadURL})
}

func (handler *claimsHandler) finalizeReceiptUpload(response http.ResponseWriter, request *http.Request) {
	actor, _ := ActorFromContext(request.Context())
	if strings.TrimSpace(request.Header.Get("Idempotency-Key")) == "" {
		writeError(response, http.StatusBadRequest, "IDEMPOTENCY_KEY_REQUIRED", "请提供 Idempotency-Key")
		return
	}
	if handler.receipts == nil {
		writeError(response, http.StatusNotImplemented, "NOT_IMPLEMENTED", "附件服务暂不可用")
		return
	}
	var body struct {
		ReceiptID string `json:"receiptId"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil || strings.TrimSpace(body.ReceiptID) == "" {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "缺少票据编号")
		return
	}
	if err := handler.receipts.FinalizeReceiptUpload(request.Context(), actor.ID, pathClaimID(request), body.ReceiptID); err != nil {
		writeMappedError(response, err)
		return
	}
	writeJSON(response, http.StatusAccepted, map[string]string{"receiptId": body.ReceiptID, "status": "READY_FOR_OCR"})
}

func (handler *claimsHandler) listReceipts(response http.ResponseWriter, request *http.Request) {
	actor, _ := ActorFromContext(request.Context())
	if handler.receipts == nil {
		writeError(response, http.StatusNotImplemented, "NOT_IMPLEMENTED", "附件服务暂不可用")
		return
	}
	receipts, err := handler.receipts.ListReceipts(request.Context(), actor.ID, pathClaimID(request))
	if err != nil {
		writeMappedError(response, err)
		return
	}
	items := make([]map[string]any, 0, len(receipts))
	for _, receipt := range receipts {
		items = append(items, receiptResponse(receipt))
	}
	writeJSON(response, http.StatusOK, map[string]any{"items": items})
}

func (handler *claimsHandler) deleteReceipt(response http.ResponseWriter, request *http.Request) {
	actor, _ := ActorFromContext(request.Context())
	if handler.receipts == nil {
		writeError(response, http.StatusNotImplemented, "NOT_IMPLEMENTED", "附件服务暂不可用")
		return
	}
	receiptID := strings.TrimSpace(request.PathValue("receiptId"))
	if receiptID == "" {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "缺少票据编号")
		return
	}
	if err := handler.receipts.DeleteReceipt(request.Context(), actor.ID, pathClaimID(request), receiptID); err != nil {
		writeMappedError(response, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func receiptResponse(receipt application.ReceiptView) map[string]any {
	var invoiceDate any
	if receipt.InvoiceDate != nil {
		invoiceDate = receipt.InvoiceDate.Format("2006-01-02")
	}
	return map[string]any{
		"id":              receipt.ID,
		"claimId":         receipt.ClaimID,
		"filename":        receipt.Filename,
		"status":          receipt.Status,
		"invoiceNumber":   receipt.InvoiceNumber,
		"invoiceDate":     invoiceDate,
		"totalAmountCent": receipt.TotalAmountCent,
		"sellerName":      receipt.SellerName,
		"ocrConfidence":   receipt.OCRConfidence,
		"closedByReview":  receipt.ClosedByReview,
		"updatedAt":       receipt.UpdatedAt,
	}
}

func (handler *claimsHandler) createClaim(response http.ResponseWriter, request *http.Request) {
	actor, _ := ActorFromContext(request.Context())
	if strings.TrimSpace(request.Header.Get("Idempotency-Key")) == "" {
		writeError(response, http.StatusBadRequest, "IDEMPOTENCY_KEY_REQUIRED", "请提供 Idempotency-Key")
		return
	}
	var body struct {
		Purpose string `json:"purpose"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容格式不正确")
		return
	}
	claim, err := handler.claims.CreateClaim(request.Context(), actor.ID, application.CreateClaimCommand{Purpose: body.Purpose})
	if err != nil {
		writeMappedError(response, err)
		return
	}
	writeJSON(response, http.StatusCreated, claimResponse(claim))
}

func (handler *claimsHandler) getClaim(response http.ResponseWriter, request *http.Request) {
	actor, _ := ActorFromContext(request.Context())
	claim, err := handler.claims.GetClaim(request.Context(), actor.ID, pathClaimID(request))
	if err != nil {
		writeMappedError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, claimResponse(claim))
}

func (handler *claimsHandler) patchClaim(response http.ResponseWriter, request *http.Request) {
	actor, _ := ActorFromContext(request.Context())
	var raw map[string]json.RawMessage
	if err := json.NewDecoder(request.Body).Decode(&raw); err != nil {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "请求内容格式不正确")
		return
	}
	versionRaw, ok := raw["version"]
	if !ok {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "缺少报销单版本")
		return
	}
	var version int64
	if err := json.Unmarshal(versionRaw, &version); err != nil || version < 1 {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "报销单版本无效")
		return
	}
	command := application.PatchClaimCommand{}
	for field, value := range raw {
		switch field {
		case "version":
		case "purpose":
			var purpose string
			if json.Unmarshal(value, &purpose) != nil {
				command.UnknownFields = append(command.UnknownFields, field)
			} else {
				command.Purpose = &purpose
			}
		case "expenseCategory":
			var category string
			if json.Unmarshal(value, &category) != nil {
				command.UnknownFields = append(command.UnknownFields, field)
			} else {
				command.ExpenseCategory = &category
			}
		case "participants":
			var participants []string
			if json.Unmarshal(value, &participants) != nil {
				command.UnknownFields = append(command.UnknownFields, field)
			} else {
				command.Participants = &participants
			}
		case "projectCode":
			var projectCode string
			if json.Unmarshal(value, &projectCode) != nil {
				command.UnknownFields = append(command.UnknownFields, field)
			} else {
				command.ProjectCode = &projectCode
			}
		case "requestedAmountCent":
			var amount int64
			if json.Unmarshal(value, &amount) != nil || amount < 0 {
				command.UnknownFields = append(command.UnknownFields, field)
			} else {
				command.RequestedAmountCent = &amount
			}
		case "currency":
			var currency string
			if json.Unmarshal(value, &currency) != nil || currency != domain.ClaimCurrencyCNY {
				command.UnknownFields = append(command.UnknownFields, field)
			} else {
				command.Currency = &currency
			}
		case "remark":
			var remark *string
			if json.Unmarshal(value, &remark) != nil {
				command.UnknownFields = append(command.UnknownFields, field)
			} else if remark == nil {
				empty := ""
				command.Remark = &empty
			} else {
				command.Remark = remark
			}
		case "useOcrSuggestedAmount":
			var restore bool
			if json.Unmarshal(value, &restore) != nil || !restore {
				command.UnknownFields = append(command.UnknownFields, field)
			} else {
				command.UseOCRSuggestedAmount = true
			}
		default:
			command.UnknownFields = append(command.UnknownFields, field)
		}
	}
	if len(command.UnknownFields) > 0 || (command.UseOCRSuggestedAmount && command.RequestedAmountCent != nil) {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "报销金额字段无效")
		return
	}
	claim, err := handler.claims.UpdateClaim(request.Context(), actor.ID, pathClaimID(request), version, command)
	if err != nil {
		writeMappedError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, claimResponse(claim))
}

func claimResponse(claim application.ClaimView) map[string]any {
	return map[string]any{
		"id":                        claim.ID,
		"claimNumber":               claim.ClaimNumber,
		"ownerId":                   claim.OwnerID,
		"status":                    claim.Status,
		"version":                   claim.Version,
		"purpose":                   claim.Purpose,
		"expenseCategory":           claim.ExpenseCategory,
		"participants":              claim.Participants,
		"projectCode":               claim.ProjectCode,
		"receiptCount":              claim.ReceiptCount,
		"recognizedReceiptCount":    claim.RecognizedReceiptCount,
		"totalAmountCent":           claim.TotalAmountCent,
		"missingAmountReceiptCount": claim.MissingAmountReceiptCount,
		"requestedAmountCent":       claim.RequestedAmountCent,
		"currency":                  claim.Currency,
		"requestedAmountSource":     claim.RequestedAmountSource,
		"remark":                    nullableString(claim.Remark),
		"createdAt":                 claim.CreatedAt,
		"updatedAt":                 claim.UpdatedAt,
	}
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (handler *claimsHandler) submitClaim(response http.ResponseWriter, request *http.Request) {
	actor, _ := ActorFromContext(request.Context())
	idempotencyKey := strings.TrimSpace(request.Header.Get("Idempotency-Key"))
	if idempotencyKey == "" {
		writeError(response, http.StatusBadRequest, "IDEMPOTENCY_KEY_REQUIRED", "请提供 Idempotency-Key")
		return
	}
	var body struct {
		ConfirmationToken string `json:"confirmationToken"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil || strings.TrimSpace(body.ConfirmationToken) == "" {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "缺少确认令牌")
		return
	}
	if handler.submissions == nil {
		writeError(response, http.StatusNotImplemented, "NOT_IMPLEMENTED", "提交服务暂不可用")
		return
	}
	snapshot, err := handler.submissions.SubmitClaim(request.Context(), actor.ID, pathClaimID(request), body.ConfirmationToken, idempotencyKey)
	if err != nil {
		writeMappedError(response, err)
		return
	}
	writeJSON(response, http.StatusCreated, snapshot)
}

func (handler *claimsHandler) validateClaim(response http.ResponseWriter, request *http.Request) {
	actor, _ := ActorFromContext(request.Context())
	if handler.submissions == nil {
		writeError(response, http.StatusNotImplemented, "NOT_IMPLEMENTED", "校验服务暂不可用")
		return
	}
	result, err := handler.submissions.ValidateClaim(request.Context(), actor.ID, pathClaimID(request))
	if err != nil {
		writeMappedError(response, err)
		return
	}
	issues := make([]map[string]any, 0, len(result.Issues))
	for _, issue := range result.Issues {
		severity := "WARNING"
		if issue.Blocking {
			severity = "BLOCKING"
		}
		issues = append(issues, map[string]any{"code": issue.Code, "severity": severity, "message": issue.Message})
	}
	writeJSON(response, http.StatusOK, map[string]any{"claimId": result.ClaimID, "claimVersion": result.ClaimVersion, "policyVersion": result.PolicyVersion, "issues": issues})
}

func (handler *claimsHandler) requestSubmission(response http.ResponseWriter, request *http.Request) {
	actor, _ := ActorFromContext(request.Context())
	if strings.TrimSpace(request.Header.Get("Idempotency-Key")) == "" {
		writeError(response, http.StatusBadRequest, "IDEMPOTENCY_KEY_REQUIRED", "请提供 Idempotency-Key")
		return
	}
	if handler.submissions == nil {
		writeError(response, http.StatusNotImplemented, "NOT_IMPLEMENTED", "提交服务暂不可用")
		return
	}
	var body struct {
		Version int64 `json:"version"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil || body.Version < 1 {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "缺少有效的报销单版本")
		return
	}
	confirmation, err := handler.submissions.RequestSubmission(request.Context(), actor.ID, pathClaimID(request), body.Version)
	if err != nil {
		writeMappedError(response, err)
		return
	}
	writeJSON(response, http.StatusCreated, map[string]any{"confirmationToken": confirmation.Token, "claimId": confirmation.ClaimID, "claimVersion": confirmation.ClaimVersion, "policyVersion": confirmation.PolicyVersion, "expiresAt": confirmation.ExpiresAt})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}
