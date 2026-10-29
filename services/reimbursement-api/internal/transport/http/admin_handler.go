package transport

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
)

type AdminServices struct {
	Policies *application.PolicyRuleService
	Reviews  *application.ReviewCaseService
	Previews *application.ReceiptPreviewService
	Role     func(context.Context, string) (string, error)
}
type adminHandler struct{ services AdminServices }

func (handler *adminHandler) authorize(request *http.Request) (Actor, bool) {
	actor, ok := ActorFromContext(request.Context())
	if !ok || !validRole(actor.Role) {
		return Actor{}, false
	}
	role, err := handler.services.Role(request.Context(), actor.ID)
	return actor, err == nil && role == actor.Role && (role == "ADMIN" || role == "FINANCE_REVIEWER")
}
func (handler *adminHandler) publishPolicy(response http.ResponseWriter, request *http.Request) {
	actor, ok := handler.authorize(request)
	if !ok || actor.Role != "ADMIN" {
		writeError(response, http.StatusForbidden, "FORBIDDEN", "无财务管理权限")
		return
	}
	var body struct {
		ID            string                   `json:"id"`
		EffectiveDate string                   `json:"effectiveDate"`
		Rules         []application.PolicyRule `json:"rules"`
	}
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil || strings.TrimSpace(body.ID) == "" {
		writeError(response, 400, "INVALID_REQUEST", "政策参数无效")
		return
	}
	if err := handler.services.Policies.Publish(actor.ID, application.PolicyVersion{ID: body.ID, EffectiveDate: body.EffectiveDate, Rules: body.Rules}); err != nil {
		if errors.Is(err, application.ErrPolicyVersionExists) {
			writeError(response, http.StatusConflict, "POLICY_VERSION_EXISTS", "该政策版本编号已发布，请使用新的版本编号。")
			return
		}
		writeError(response, 400, "INVALID_REQUEST", err.Error())
		return
	}
	writeJSON(response, 201, map[string]string{"id": body.ID, "status": "PUBLISHED"})
}
func (handler *adminHandler) resolveReview(response http.ResponseWriter, request *http.Request) {
	actor, ok := handler.authorize(request)
	if !ok {
		writeError(response, 403, "FORBIDDEN", "无财务复核权限")
		return
	}
	var body struct {
		ExpectedVersion int64   `json:"expectedVersion"`
		Action          string  `json:"action"`
		Resolution      string  `json:"resolution"`
		InvoiceNumber   string  `json:"invoiceNumber"`
		InvoiceDate     string  `json:"invoiceDate"`
		TotalAmountCent *int64  `json:"totalAmountCent"`
		SellerName      *string `json:"sellerName"`
	}
	if json.NewDecoder(request.Body).Decode(&body) != nil || body.ExpectedVersion < 1 || strings.TrimSpace(body.Resolution) == "" {
		writeError(response, 400, "INVALID_REQUEST", "复核参数无效")
		return
	}
	action := application.ReviewCaseAction(strings.TrimSpace(body.Action))
	var invoiceDate *time.Time
	if action == application.ReviewCaseActionCorrectFields {
		parsedInvoiceDate, err := time.Parse("2006-01-02", body.InvoiceDate)
		if err != nil || strings.TrimSpace(body.InvoiceNumber) == "" || body.TotalAmountCent == nil || *body.TotalAmountCent < 0 {
			writeError(response, 400, "INVALID_REQUEST", "更正票据字段无效")
			return
		}
		invoiceDate = &parsedInvoiceDate
	}
	if body.SellerName != nil {
		sellerName := strings.TrimSpace(*body.SellerName)
		body.SellerName = &sellerName
	}
	reviewCase, err := handler.services.Reviews.ResolveReceiptCase(request.Context(), actor.ID, actor.Role, application.ResolveReceiptCaseCommand{CaseID: request.PathValue("reviewId"), ExpectedVersion: body.ExpectedVersion, Action: action, Resolution: body.Resolution, InvoiceNumber: strings.TrimSpace(body.InvoiceNumber), InvoiceDate: invoiceDate, TotalAmountCent: body.TotalAmountCent, SellerName: body.SellerName})
	if err != nil {
		handler.writeReviewError(response, err)
		return
	}
	writeJSON(response, 200, reviewCase)
}

func (handler *adminHandler) listReviews(response http.ResponseWriter, request *http.Request) {
	actor, ok := handler.authorize(request)
	if !ok {
		writeError(response, http.StatusForbidden, "FORBIDDEN", "无财务复核权限")
		return
	}
	reviews, err := handler.services.Reviews.ListReceiptCases(request.Context(), actor.Role)
	if err != nil {
		handler.writeReviewError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"items": reviews})
}

func (handler *adminHandler) getReview(response http.ResponseWriter, request *http.Request) {
	actor, ok := handler.authorize(request)
	if !ok {
		writeError(response, http.StatusForbidden, "FORBIDDEN", "无财务复核权限")
		return
	}
	reviewCase, err := handler.services.Reviews.GetReceiptCase(request.Context(), actor.Role, request.PathValue("reviewId"))
	if err != nil {
		handler.writeReviewError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, reviewCase)
}

func (handler *adminHandler) previewReceipt(response http.ResponseWriter, request *http.Request) {
	actor, ok := handler.authorize(request)
	if !ok {
		writeError(response, http.StatusForbidden, "FORBIDDEN", "无财务复核权限")
		return
	}
	if handler.services.Previews == nil {
		writeError(response, http.StatusServiceUnavailable, "RECEIPT_PREVIEW_UNAVAILABLE", "原票暂不可用，请联系系统管理员后重试。")
		return
	}
	preview, err := handler.services.Previews.Get(request.Context(), actor.Role, request.PathValue("reviewId"))
	if err != nil {
		handler.writeReviewError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, preview)
}

func (handler *adminHandler) claimReview(response http.ResponseWriter, request *http.Request) {
	actor, ok := handler.authorize(request)
	if !ok {
		writeError(response, http.StatusForbidden, "FORBIDDEN", "无财务复核权限")
		return
	}
	var body struct {
		ExpectedVersion int64 `json:"expectedVersion"`
	}
	if json.NewDecoder(request.Body).Decode(&body) != nil || body.ExpectedVersion < 1 {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "领取参数无效")
		return
	}
	reviewCase, err := handler.services.Reviews.ClaimReceiptCase(request.Context(), actor.ID, actor.Role, application.ClaimReviewCaseCommand{CaseID: request.PathValue("reviewId"), ExpectedVersion: body.ExpectedVersion})
	if err != nil {
		handler.writeReviewError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, reviewCase)
}

func (handler *adminHandler) writeReviewError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, application.ErrReviewCaseForbidden):
		writeError(response, http.StatusForbidden, "FORBIDDEN", "无财务复核权限")
	case errors.Is(err, application.ErrReviewCaseNotFound):
		writeError(response, http.StatusNotFound, "REVIEW_CASE_NOT_FOUND", "复核案件不存在")
	case errors.Is(err, application.ErrInvalidReviewCase):
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "复核参数无效")
	case errors.Is(err, application.ErrDuplicateSubmittedInvoice):
		writeError(response, http.StatusConflict, "DUPLICATE_SUBMITTED_INVOICE", "发票号码已在已提交报销单中使用，请核对后重试")
	case errors.Is(err, application.ErrReviewCaseConflict):
		writeError(response, http.StatusConflict, "REVIEW_CASE_CONFLICT", "复核案件已被其他操作更新")
	case errors.Is(err, application.ErrReceiptPreviewUnavailable):
		writeError(response, http.StatusConflict, "RECEIPT_PREVIEW_UNAVAILABLE", "原票暂不可用，请联系系统管理员后重试。")
	default:
		writeError(response, http.StatusInternalServerError, "REVIEW_CASE_FAILED", "复核操作失败")
	}
}
