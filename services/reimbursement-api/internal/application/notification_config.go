package application

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

type NotificationConfig struct {
	Events []NotificationEventConfig `json:"events"`
}

type NotificationEventConfig struct {
	EventCode string `json:"eventCode"`
	Channel   string `json:"channel"`
	Enabled   *bool  `json:"enabled"`
	Template  string `json:"template"`
}

var connectedNotificationEvents = map[string]bool{
	"ReceiptExtractionCompleted": true,
	"ReceiptReviewRequired":      true,
	"ReceiptReviewResolved":      true,
	"ClaimSubmitted":             true,
}

var notificationPlaceholder = regexp.MustCompile(`\{\{([^{}]+)\}\}`)
var notificationExternalLink = regexp.MustCompile(`(?i)(?:[a-z][a-z0-9+.-]*://|www\.|mailto:|\[[^\]]+\]\([^)]*\)|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b)`)

func ValidateNotificationConfigPayload(payload json.RawMessage) error {
	if bytes.Equal(bytes.TrimSpace(payload), []byte("null")) {
		return ErrConfigInvalid
	}
	var config NotificationConfig
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return fmt.Errorf("%w: notification config: %v", ErrConfigInvalid, err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return ErrConfigInvalid
	}
	if len(config.Events) == 0 || len(config.Events) > len(connectedNotificationEvents) {
		return ErrConfigInvalid
	}
	seen := map[string]bool{}
	for _, event := range config.Events {
		if !connectedNotificationEvents[event.EventCode] || event.Channel != "FEISHU" || event.Enabled == nil || seen[event.EventCode] {
			return ErrConfigInvalid
		}
		seen[event.EventCode] = true
		if utf8.RuneCountInString(event.Template) > 400 || strings.Count(event.Template, "{{body}}") != 1 || notificationExternalLink.MatchString(event.Template) {
			return ErrConfigInvalid
		}
		if notificationPlaceholder.ReplaceAllString(event.Template, "") == event.Template {
			return ErrConfigInvalid
		}
		for _, match := range notificationPlaceholder.FindAllString(event.Template, -1) {
			if match != "{{body}}" {
				return ErrConfigInvalid
			}
		}
		if strings.ContainsAny(notificationPlaceholder.ReplaceAllString(event.Template, ""), "{}") {
			return ErrConfigInvalid
		}
		for _, char := range event.Template {
			if unicode.IsControl(char) && char != '\n' {
				return ErrConfigInvalid
			}
		}
	}
	return nil
}
