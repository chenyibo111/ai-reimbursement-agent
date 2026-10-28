package transport

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClaimSearchRejectsInvalidFiltersWithoutFallingBackToList(t *testing.T) {
	handler := NewRouter(Dependencies{Claims: fakeClaims{}, Auth: StaticActorResolver{}})
	for _, path := range []string{
		"/api/v1/claims?status=UNKNOWN",
		"/api/v1/claims?search=true&limit=101",
		"/api/v1/claims?search=true&cursor=bad",
		"/api/v1/claims?createdFrom=2026-10-10&createdBefore=2026-10-01",
		"/api/v1/claims?page=0",
		"/api/v1/claims?page=-1",
		"/api/v1/claims?page=10001",
		"/api/v1/claims?page=abc",
		"/api/v1/claims?page=1&cursor=bad",
		"/api/v1/claims?page=1&cursor=",
		"/api/v1/claims?page=1&countOnly=true",
		"/api/v1/claims?page=1&countOnly=",
	} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Header.Set("Authorization", "Bearer employee-1")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d, body %s", path, response.Code, response.Body.String())
		}
	}
}
