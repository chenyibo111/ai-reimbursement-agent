package transport

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/application"
)

type configHandler struct {
	service    *application.ConfigService
	role       func(context.Context, string) (string, error)
	serviceKey []byte
}

func (handler *configHandler) authorize(request *http.Request) (Actor, bool) {
	actor, ok := ActorFromContext(request.Context())
	if !ok || actor.Role != "ADMIN" || handler.role == nil {
		return Actor{}, false
	}
	storedRole, err := handler.role(request.Context(), actor.ID)
	return actor, err == nil && storedRole == "ADMIN"
}

func (handler *configHandler) getAdmin(response http.ResponseWriter, request *http.Request) {
	if _, ok := handler.authorize(request); !ok {
		configForbidden(response)
		return
	}
	configDomain := request.PathValue("domain")
	draft, draftErr := handler.service.GetDraft(request.Context(), configDomain)
	active, activeErr := handler.service.GetActive(request.Context(), configDomain)
	if draftErr != nil && !errors.Is(draftErr, application.ErrConfigNotFound) {
		writeConfigError(response, draftErr)
		return
	}
	if activeErr != nil && !errors.Is(activeErr, application.ErrConfigNotFound) {
		writeConfigError(response, activeErr)
		return
	}
	if draftErr != nil && activeErr != nil {
		writeConfigError(response, application.ErrConfigNotFound)
		return
	}
	result := map[string]any{}
	if draftErr == nil {
		result["draft"] = draft
	}
	if activeErr == nil {
		result["active"] = active
	}
	writeJSON(response, http.StatusOK, result)
}

func (handler *configHandler) saveDraft(response http.ResponseWriter, request *http.Request) {
	actor, ok := handler.authorize(request)
	if !ok {
		configForbidden(response)
		return
	}
	var body struct {
		ExpectedRevision int64           `json:"expectedRevision"`
		Payload          json.RawMessage `json:"payload"`
		Note             string          `json:"note"`
	}
	if !decodeConfigBody(response, request, &body) {
		return
	}
	draft, err := handler.service.SaveDraft(request.Context(), actor.ID, request.PathValue("domain"), body.ExpectedRevision, body.Payload, body.Note)
	if err != nil {
		writeConfigError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, draft)
}

func (handler *configHandler) preview(response http.ResponseWriter, request *http.Request) {
	if _, ok := handler.authorize(request); !ok {
		configForbidden(response)
		return
	}
	var body struct {
		Revision int64 `json:"revision"`
	}
	if !decodeConfigBody(response, request, &body) {
		return
	}
	preview, err := handler.service.PreviewDraft(request.Context(), request.PathValue("domain"), body.Revision)
	if err != nil {
		writeConfigError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, preview)
}

func (handler *configHandler) approve(response http.ResponseWriter, request *http.Request) {
	actor, ok := handler.authorize(request)
	if !ok {
		configForbidden(response)
		return
	}
	var body struct {
		Revision int64 `json:"revision"`
	}
	if !decodeConfigBody(response, request, &body) {
		return
	}
	draft, err := handler.service.ApproveDraft(request.Context(), actor.ID, request.PathValue("domain"), body.Revision)
	if err != nil {
		writeConfigError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, draft)
}

func (handler *configHandler) publish(response http.ResponseWriter, request *http.Request) {
	actor, ok := handler.authorize(request)
	if !ok {
		configForbidden(response)
		return
	}
	var body struct {
		Revision int64 `json:"revision"`
	}
	if !decodeConfigBody(response, request, &body) {
		return
	}
	snapshot, err := handler.service.PublishDraft(request.Context(), actor.ID, request.PathValue("domain"), body.Revision)
	if err != nil {
		writeConfigError(response, err)
		return
	}
	writeJSON(response, http.StatusCreated, snapshot)
}

func (handler *configHandler) activate(response http.ResponseWriter, request *http.Request) {
	actor, ok := handler.authorize(request)
	if !ok {
		configForbidden(response)
		return
	}
	var body struct {
		ExpectedActiveVersion int64  `json:"expectedActiveVersion"`
		Version               int64  `json:"version"`
		Note                  string `json:"note"`
	}
	if !decodeConfigBody(response, request, &body) {
		return
	}
	snapshot, err := handler.service.ActivateVersion(request.Context(), actor.ID, request.PathValue("domain"), body.ExpectedActiveVersion, body.Version, body.Note)
	if err != nil {
		writeConfigError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, snapshot)
}

func (handler *configHandler) history(response http.ResponseWriter, request *http.Request) {
	if _, ok := handler.authorize(request); !ok {
		configForbidden(response)
		return
	}
	items, err := handler.service.ListHistory(request.Context(), request.PathValue("domain"))
	if err != nil {
		writeConfigError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"items": items})
}

func (handler *configHandler) getPublic(response http.ResponseWriter, request *http.Request) {
	configDomain := request.PathValue("domain")
	if configDomain != "expense_catalog" && configDomain != "form_options" {
		configForbidden(response)
		return
	}
	snapshot, err := handler.service.GetActive(request.Context(), configDomain)
	if err != nil {
		writeConfigError(response, err)
		return
	}
	if configDomain == "expense_catalog" {
		var catalog struct {
			Categories []application.Category `json:"categories"`
		}
		if err := json.Unmarshal(snapshot.Payload, &catalog); err != nil {
			writeConfigError(response, err)
			return
		}
		available := make([]application.Category, 0, len(catalog.Categories))
		for _, category := range catalog.Categories {
			if category.Enabled {
				available = append(available, category)
			}
		}
		payload, err := json.Marshal(map[string]any{"categories": available})
		if err != nil {
			writeConfigError(response, err)
			return
		}
		snapshot.Payload = payload
	}
	writeJSON(response, http.StatusOK, snapshot)
}

func (handler *configHandler) getInternal(response http.ResponseWriter, request *http.Request) {
	if len(handler.serviceKey) == 0 || subtle.ConstantTimeCompare([]byte(request.Header.Get("X-Auth-Provisioning-Key")), handler.serviceKey) != 1 {
		writeError(response, http.StatusUnauthorized, "UNAUTHENTICATED", "内部配置读取未获授权")
		return
	}
	snapshot, err := handler.service.GetActive(request.Context(), request.PathValue("domain"))
	if err != nil {
		writeConfigError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, snapshot)
}

func decodeConfigBody(response http.ResponseWriter, request *http.Request, destination any) bool {
	request.Body = http.MaxBytesReader(response, request.Body, 64*1024)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "配置参数无效")
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(response, http.StatusBadRequest, "INVALID_REQUEST", "配置参数无效")
		return false
	}
	return true
}

func configForbidden(response http.ResponseWriter) {
	writeError(response, http.StatusForbidden, "FORBIDDEN", "无配置管理权限")
}

func writeConfigError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, application.ErrConfigDomain), errors.Is(err, application.ErrConfigNotFound):
		writeError(response, http.StatusNotFound, "CONFIG_NOT_FOUND", "配置不存在")
	case errors.Is(err, application.ErrConfigInvalid):
		writeError(response, http.StatusBadRequest, "INVALID_CONFIG", "配置参数无效")
	case errors.Is(err, application.ErrConfigConflict):
		writeError(response, http.StatusConflict, "CONFIG_CONFLICT", "配置版本已更新，请刷新后重试")
	case errors.Is(err, application.ErrConfigApproval):
		writeError(response, http.StatusConflict, "CONFIG_APPROVAL_REQUIRED", "需要另一位管理员复核")
	case errors.Is(err, application.ErrConfigValidatorUnavailable):
		writeError(response, http.StatusServiceUnavailable, "CONFIG_UNAVAILABLE", "配置领域尚未启用")
	default:
		writeError(response, http.StatusInternalServerError, "CONFIG_ERROR", "配置操作失败")
	}
}
