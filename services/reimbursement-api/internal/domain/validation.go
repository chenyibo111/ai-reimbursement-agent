package domain

type ValidationIssue struct {
	Code     string
	Message  string
	Blocking bool
}

func (issue ValidationIssue) IsBlocking() bool { return issue.Blocking }
