package services

import (
	"sync"
	"testing"
	"time"
)

func TestEventBatcherCoalesces(t *testing.T) {
	var mu sync.Mutex
	var batches [][]any
	b := newEventBatcher(func(ps []any) {
		mu.Lock()
		batches = append(batches, ps)
		mu.Unlock()
	})
	for i := 0; i < 1000; i++ {
		b.add(i)
	}
	time.Sleep(4 * eventBatchInterval)
	b.add("late")
	time.Sleep(4 * eventBatchInterval)
	mu.Lock()
	defer mu.Unlock()
	if len(batches) != 2 || len(batches[0]) != 1000 || batches[0][999] != 999 || len(batches[1]) != 1 {
		t.Fatalf("batches %d, first %d", len(batches), len(batches[0]))
	}
}
