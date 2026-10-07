package transport

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
)

type claimsHandler struct {
	claims      ClaimService
	submissions SubmissionService
	receipts    ReceiptService
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
	session, err := handler.receipts.CreateUploadSession(request.Context(), actor.ID, pathClaimID(request), application.CreateUploadSessionCommand{Filename: body.Filename, ContentType: body.ContentType, SizeBytes: body.SizeBytes})
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
	writeJSON(response, http.StatusCreated, map[string]any{"id": claim.ID, "ownerId": claim.OwnerID, "status": claim.Status, "version": claim.Version, "purpose": claim.Purpose})
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
