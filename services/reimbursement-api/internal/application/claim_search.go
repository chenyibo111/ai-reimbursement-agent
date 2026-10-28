package application

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/chenyibo111/ai-reimbursement-agent/services/reimbursement-api/internal/domain"
)

var ErrInvalidClaimSearch = errors.New("invalid claim search")

const (
	ClaimSearchCreatedDesc = "created_desc"
	ClaimSearchCreatedAsc  = "created_asc"
	ClaimSearchAmountDesc  = "amount_desc"
	ClaimSearchAmountAsc   = "amount_asc"
)

type SearchClaimsQuery struct {
	Status                 string
	CreatedFrom            time.Time
	CreatedBefore          time.Time
	PurposeContains        string
	ExpenseCategory        string
	MinRequestedAmountCent *int64
	MaxRequestedAmountCent *int64
	Sort                   string
	Limit                  int
	Page                   int `json:"-"` // Keep this out of legacy cursor fingerprints.
	Cursor                 string
	CountOnly              bool
	AfterValue             string
	AfterID                string
	AfterNull              bool
}

type SearchClaimsPage struct {
	Items      []ClaimView `json:"items"`
	TotalCount int64       `json:"totalCount"`
	NextCursor string      `json:"nextCursor"`
}

type claimSearchCursor struct {
	Sort  string `json:"s"`
	Value string `json:"v"`
	ID    string `json:"i"`
	Null  bool   `json:"n,omitempty"`
	Hash  string `json:"h"`
}

type claimSearchRepository interface {
	SearchOwned(context.Context, string, SearchClaimsQuery) ([]domain.Claim, int64, error)
}

func (service *ClaimService) SearchClaims(ctx context.Context, actorID string, query SearchClaimsQuery) (SearchClaimsPage, error) {
	if query.Sort == "" {
		query.Sort = ClaimSearchCreatedDesc
	}
	if query.Limit == 0 {
		query.Limit = 5
	}
	if query.Limit < 1 || query.Limit > 100 || query.Page < 0 || query.Page > 10000 ||
		(query.Page > 0 && (query.Cursor != "" || query.CountOnly)) ||
		(query.Status != "" && query.Status != string(domain.ClaimStatusDraft) && query.Status != string(domain.ClaimStatusSubmitted)) ||
		(query.Sort != ClaimSearchCreatedDesc && query.Sort != ClaimSearchCreatedAsc && query.Sort != ClaimSearchAmountDesc && query.Sort != ClaimSearchAmountAsc) ||
		(!query.CreatedFrom.IsZero() && !query.CreatedBefore.IsZero() && !query.CreatedFrom.Before(query.CreatedBefore)) ||
		(query.MinRequestedAmountCent != nil && *query.MinRequestedAmountCent < 0) ||
		(query.MaxRequestedAmountCent != nil && *query.MaxRequestedAmountCent < 0) ||
		(query.MinRequestedAmountCent != nil && query.MaxRequestedAmountCent != nil && *query.MinRequestedAmountCent > *query.MaxRequestedAmountCent) ||
		len([]rune(query.PurposeContains)) > 200 || len([]rune(query.ExpenseCategory)) > 100 {
		return SearchClaimsPage{}, ErrInvalidClaimSearch
	}
	// A cursor belongs to one authenticated owner's exact filter set. Page size may change.
	fingerprintQuery := query
	fingerprintQuery.Limit, fingerprintQuery.Page, fingerprintQuery.Cursor, fingerprintQuery.CountOnly = 0, 0, "", false
	fingerprintQuery.AfterValue, fingerprintQuery.AfterID, fingerprintQuery.AfterNull = "", "", false
	fingerprintInput, _ := json.Marshal(struct {
		Owner string
		Query SearchClaimsQuery
	}{actorID, fingerprintQuery})
	fingerprint := fmt.Sprintf("%x", sha256.Sum256(fingerprintInput))
	if query.Cursor != "" {
		bytes, err := base64.RawURLEncoding.DecodeString(query.Cursor)
		if err != nil || len(bytes) > 500 {
			return SearchClaimsPage{}, ErrInvalidClaimSearch
		}
		var cursor claimSearchCursor
		if json.Unmarshal(bytes, &cursor) != nil || cursor.Sort != query.Sort || cursor.Hash != fingerprint || cursor.ID == "" || (cursor.Value == "" && !cursor.Null) {
			return SearchClaimsPage{}, ErrInvalidClaimSearch
		}
		if strings.HasPrefix(query.Sort, "created_") {
			if cursor.Null {
				return SearchClaimsPage{}, ErrInvalidClaimSearch
			}
			if _, err := time.Parse(time.RFC3339Nano, cursor.Value); err != nil {
				return SearchClaimsPage{}, ErrInvalidClaimSearch
			}
		} else if !cursor.Null {
			var amount int64
			if _, err := fmt.Sscan(cursor.Value, &amount); err != nil || amount < 0 {
				return SearchClaimsPage{}, ErrInvalidClaimSearch
			}
		}
		query.AfterValue, query.AfterID, query.AfterNull = cursor.Value, cursor.ID, cursor.Null
	}
	repository, ok := service.repository.(claimSearchRepository)
	if !ok {
		return SearchClaimsPage{}, errors.New("claim search repository unavailable")
	}
	claims, total, err := repository.SearchOwned(ctx, actorID, query)
	if err != nil {
		return SearchClaimsPage{}, fmt.Errorf("search owned claims: %w", err)
	}
	page := SearchClaimsPage{Items: []ClaimView{}, TotalCount: total}
	if query.CountOnly {
		return page, nil
	}
	more := len(claims) > query.Limit
	if more && query.Page == 0 {
		claims = claims[:query.Limit]
	}
	for _, claim := range claims {
		page.Items = append(page.Items, claim.Clone())
	}
	if more {
		last := claims[len(claims)-1]
		cursor := claimSearchCursor{Sort: query.Sort, ID: last.ID, Hash: fingerprint}
		if strings.HasPrefix(query.Sort, "created_") {
			cursor.Value = last.CreatedAt.UTC().Format(time.RFC3339Nano)
		} else if last.RequestedAmountCent == nil {
			cursor.Null = true
		} else {
			cursor.Value = fmt.Sprint(*last.RequestedAmountCent)
		}
		encoded, _ := json.Marshal(cursor)
		page.NextCursor = base64.RawURLEncoding.EncodeToString(encoded)
	}
	return page, nil
}

func filterAndSortClaims(claims []domain.Claim, query SearchClaimsQuery) []domain.Claim {
	filtered := make([]domain.Claim, 0, len(claims))
	for _, claim := range claims {
		if query.Status != "" && string(claim.Status) != query.Status {
			continue
		}
		if !query.CreatedFrom.IsZero() && claim.CreatedAt.Before(query.CreatedFrom) {
			continue
		}
		if !query.CreatedBefore.IsZero() && !claim.CreatedAt.Before(query.CreatedBefore) {
			continue
		}
		if query.PurposeContains != "" && !strings.Contains(strings.ToLower(claim.Purpose), strings.ToLower(query.PurposeContains)) {
			continue
		}
		if query.ExpenseCategory != "" && claim.ExpenseCategory != query.ExpenseCategory {
			continue
		}
		if query.MinRequestedAmountCent != nil && (claim.RequestedAmountCent == nil || *claim.RequestedAmountCent < *query.MinRequestedAmountCent) {
			continue
		}
		if query.MaxRequestedAmountCent != nil && (claim.RequestedAmountCent == nil || *claim.RequestedAmountCent > *query.MaxRequestedAmountCent) {
			continue
		}
		filtered = append(filtered, claim)
	}
	sort.Slice(filtered, func(i, j int) bool {
		a, b := filtered[i], filtered[j]
		switch query.Sort {
		case ClaimSearchAmountAsc, ClaimSearchAmountDesc:
			if a.RequestedAmountCent == nil || b.RequestedAmountCent == nil {
				if a.RequestedAmountCent == nil && b.RequestedAmountCent == nil {
					return a.ID < b.ID
				}
				return a.RequestedAmountCent != nil
			}
			if *a.RequestedAmountCent != *b.RequestedAmountCent {
				if query.Sort == ClaimSearchAmountAsc {
					return *a.RequestedAmountCent < *b.RequestedAmountCent
				}
				return *a.RequestedAmountCent > *b.RequestedAmountCent
			}
		default:
			if !a.CreatedAt.Equal(b.CreatedAt) {
				if query.Sort == ClaimSearchCreatedAsc {
					return a.CreatedAt.Before(b.CreatedAt)
				}
				return a.CreatedAt.After(b.CreatedAt)
			}
		}
		return a.ID < b.ID
	})
	return filtered
}
