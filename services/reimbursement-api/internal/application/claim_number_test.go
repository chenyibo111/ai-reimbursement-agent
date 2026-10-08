package application

import (
	"context"
	"testing"
	"time"
)

func TestMemoryClaimNumberGeneratorUsesShanghaiBusinessDateAndDailySequence(t *testing.T) {
	generator := NewMemoryClaimNumberGenerator()
	ctx := context.Background()

	first, err := generator.Next(ctx, time.Date(2026, 10, 8, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("allocate first number: %v", err)
	}
	second, err := generator.Next(ctx, time.Date(2026, 10, 8, 8, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("allocate second number: %v", err)
	}
	nextDay, err := generator.Next(ctx, time.Date(2026, 10, 8, 16, 30, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("allocate next-day number: %v", err)
	}

	if first != "BX20261008-0001" {
		t.Fatalf("first number = %q, want BX20261008-0001", first)
	}
	if second != "BX20261008-0002" {
		t.Fatalf("second number = %q, want BX20261008-0002", second)
	}
	if nextDay != "BX20261009-0001" {
		t.Fatalf("next-day number = %q, want BX20261009-0001", nextDay)
	}
}
