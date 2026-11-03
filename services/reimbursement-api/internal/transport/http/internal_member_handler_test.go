package transport

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/store"
)

type fakeMemberResolver struct{ input store.MemberIdentity }

func (fake *fakeMemberResolver) ResolveMember(_ context.Context, input store.MemberIdentity) (store.EmployeeIdentity, error) {
	fake.input = input
	return store.EmployeeIdentity{ID: "employee-1", Role: "EMPLOYEE", IsActive: true}, nil
}

func TestInternalMemberResolveRequiresServiceKeyAndTrustedApp(t *testing.T) {
	fake := &fakeMemberResolver{}
	router := NewRouter(Dependencies{Members: fake, ProvisioningKey: "test-service-key", BotAppID: "cli_bot", TenantKey: "tenant-test"})
	call := func(key, appID string) *httptest.ResponseRecorder {
		body := `{"tenantKey":"tenant-test","userId":"u_member","appId":"` + appID + `","openId":"ou_member","displayName":"成员"}`
		request := httptest.NewRequest(http.MethodPost, "/internal/v1/employee-identities/resolve", strings.NewReader(body))
		request.Header.Set("X-Auth-Provisioning-Key", key)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}
	if got := call("wrong", "cli_bot"); got.Code != http.StatusUnauthorized {
		t.Fatalf("wrong key accepted: %d", got.Code)
	}
	if got := call("test-service-key", "cli_other"); got.Code != http.StatusForbidden {
		t.Fatalf("wrong app accepted: %d", got.Code)
	}
	if got := call("test-service-key", "cli_bot"); got.Code != http.StatusOK || !strings.Contains(got.Body.String(), `"employeeId":"employee-1"`) || fake.input.UserID != "u_member" {
		t.Fatalf("valid member rejected: %d %s", got.Code, got.Body.String())
	}
}
