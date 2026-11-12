package domain

type ValidationIssue struct {
	Code      string
	Message   string
	Blocking  bool
	ItemID    string `json:"itemId,omitempty"`
	ReceiptID string `json:"receiptId,omitempty"`
}

func (issue ValidationIssue) IsBlocking() bool { return issue.Blocking }
