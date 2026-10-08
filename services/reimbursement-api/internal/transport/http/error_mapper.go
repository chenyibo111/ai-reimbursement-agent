package transport

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

func writeMappedError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, application.ErrClaimNotFound):
		writeError(response, http.StatusNotFound, "NOT_FOUND", "未找到可访问的报销单")
	case errors.Is(err, application.ErrValidationBlocked):
		writeError(response, http.StatusUnprocessableEntity, "VALIDATION_BLOCKED", "报销单尚未满足提交条件")
	case errors.Is(err, application.ErrStaleSubmissionConfirmation), errors.Is(err, application.ErrClaimVersionConflict), errors.Is(err, domain.ErrClaimVersionConflict):
		writeError(response, http.StatusConflict, "VERSION_CONFLICT", "报销单已变化，请重新确认")
	case errors.Is(err, application.ErrSubmissionConfirmationExpired):
		writeError(response, http.StatusConflict, "CONFIRMATION_EXPIRED", "确认已过期，请重新发起提交")
	case errors.Is(err, application.ErrReceiptNotFound):
		writeError(response, http.StatusNotFound, "NOT_FOUND", "未找到可访问的票据")
	case errors.Is(err, domain.ErrInvalidClaim):
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "报销单字段无效")
	case errors.Is(err, application.ErrInvalidReceiptType), errors.Is(err, application.ErrInvalidReceiptSize), errors.Is(err, application.ErrInvalidFileSignature):
		writeError(response, http.StatusUnprocessableEntity, "INVALID_RECEIPT", "票据文件不符合上传要求")
	case errors.Is(err, application.ErrUnsafeReceiptFile), errors.Is(err, application.ErrDuplicateReceiptContent), errors.Is(err, application.ErrDuplicateSubmittedInvoice):
		writeError(response, http.StatusUnprocessableEntity, "RECEIPT_REVIEW_REQUIRED", "票据需要人工复核")
	default:
		writeError(response, http.StatusInternalServerError, "INTERNAL_ERROR", "操作未完成，请稍后重试")
	}
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(map[string]string{"code": code, "message": message, "requestId": ""})
}
