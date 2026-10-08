package application

import (
	"context"
	"fmt"
	"sync"
	"time"
)

var shanghaiLocation = time.FixedZone("Asia/Shanghai", 8*60*60)

// ClaimNumberGenerator allocates immutable, employee-facing claim numbers.
// Production uses PostgreSQL so concurrent API instances share the sequence.
type ClaimNumberGenerator interface {
	Next(context.Context, time.Time) (string, error)
}

type MemoryClaimNumberGenerator struct {
	mu        sync.Mutex
	sequences map[string]int
}

func NewMemoryClaimNumberGenerator() *MemoryClaimNumberGenerator {
	return &MemoryClaimNumberGenerator{sequences: make(map[string]int)}
}

func (generator *MemoryClaimNumberGenerator) Next(_ context.Context, at time.Time) (string, error) {
	businessDate := at.In(shanghaiLocation)
	dateKey := businessDate.Format("20060102")
	generator.mu.Lock()
	defer generator.mu.Unlock()
	generator.sequences[dateKey]++
	return fmt.Sprintf("BX%s-%04d", dateKey, generator.sequences[dateKey]), nil
}
