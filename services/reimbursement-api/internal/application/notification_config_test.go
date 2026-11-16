package application

import (
	"encoding/json"
	"testing"
)

func TestNotificationConfigAcceptsOnlyConnectedFeishuEventsAndSafeTemplates(t *testing.T) {
	valid := `{"events":[{"eventCode":"ReceiptExtractionCompleted","channel":"FEISHU","enabled":true,"template":"通知：{{body}}"},{"eventCode":"ClaimSubmitted","channel":"FEISHU","enabled":false,"template":"{{body}}"}]}`
	if err := ValidateNotificationConfigPayload(json.RawMessage(valid)); err != nil {
		t.Fatalf("valid notification config: %v", err)
	}
	invalid := []string{
		`{"events":[{"eventCode":"ClaimSubmitted","channel":"WEB","enabled":true,"template":"{{body}}"}]}`,
		`{"events":[{"eventCode":"UnknownEvent","channel":"FEISHU","enabled":true,"template":"{{body}}"}]}`,
		`{"events":[{"eventCode":"ClaimSubmitted","channel":"FEISHU","enabled":true,"template":"{{invoiceFullText}}"}]}`,
		`{"events":[{"eventCode":"ClaimSubmitted","channel":"FEISHU","enabled":true,"template":"查看 https://external.example/{{body}}"}]}`,
		`{"events":[{"eventCode":"ClaimSubmitted","channel":"FEISHU","enabled":true,"template":"查看 external.example {{body}}"}]}`,
		`{"events":[{"eventCode":"ClaimSubmitted","channel":"FEISHU","template":"{{body}}"}]}`,
		`{"events":[{"eventCode":"ClaimSubmitted","channel":"FEISHU","enabled":true,"template":"没有安全正文"}]}`,
		`{"events":[{"eventCode":"ClaimSubmitted","channel":"FEISHU","enabled":true,"template":"{{body}}"},{"eventCode":"ClaimSubmitted","channel":"FEISHU","enabled":true,"template":"{{body}}"}]}`,
	}
	for _, raw := range invalid {
		if err := ValidateNotificationConfigPayload(json.RawMessage(raw)); err == nil {
			t.Errorf("accepted unsafe notification config: %s", raw)
		}
	}
}
