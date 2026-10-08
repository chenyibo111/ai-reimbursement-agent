package application

import "context"

// ClaimOCRSuggestionRefresher recalculates a draft's OCR-derived requested
// amount. Implementations must leave manually entered amounts untouched.
type ClaimOCRSuggestionRefresher interface {
	RefreshOCRSuggestion(context.Context, string, string) error
}
