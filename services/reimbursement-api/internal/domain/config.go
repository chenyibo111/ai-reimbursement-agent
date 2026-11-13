package domain

import (
	"encoding/json"
	"time"
)

type ConfigSnapshot struct {
	Domain      string          `json:"domain"`
	Version     int64           `json:"version"`
	Payload     json.RawMessage `json:"payload"`
	PublishedAt time.Time       `json:"publishedAt"`
}

type ConfigDraft struct {
	Domain     string          `json:"domain"`
	Revision   int64           `json:"revision"`
	Payload    json.RawMessage `json:"payload"`
	AuthorID   string          `json:"authorId"`
	Note       string          `json:"note"`
	ApprovedBy string          `json:"approvedBy,omitempty"`
}

type ConfigPreview struct {
	Draft  ConfigDraft     `json:"draft"`
	Active *ConfigSnapshot `json:"active,omitempty"`
}

type ConfigAuditEntry struct {
	Action        string    `json:"action"`
	ActorID       string    `json:"actorId"`
	Version       int64     `json:"version"`
	Previous      int64     `json:"previousVersion"`
	DraftRevision int64     `json:"draftRevision"`
	Note          string    `json:"note"`
	At            time.Time `json:"at"`
}
