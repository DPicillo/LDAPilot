package services

import (
	"sync"
	"time"
)

// eventBatchInterval is how long an event batcher collects payloads before
// it sends them as one event.
const eventBatchInterval = 50 * time.Millisecond

// eventBatcher coalesces the payloads of a Wails event: payloads added
// within eventBatchInterval are sent together, with one emit call. An LDIF
// import of 100,000 records produced 300,000 single operation:log and
// audit:entry events, and the window was busy with them for minutes after
// the server had finished.
type eventBatcher struct {
	mu       sync.Mutex
	pending  []any
	timer    *time.Timer
	interval time.Duration
	emit     func(payloads []any)
}

func newEventBatcher(emit func(payloads []any)) *eventBatcher {
	return &eventBatcher{interval: eventBatchInterval, emit: emit}
}

// add queues a payload; the batch is sent eventBatchInterval after its
// first payload.
func (b *eventBatcher) add(p any) {
	b.mu.Lock()
	b.pending = append(b.pending, p)
	if b.timer == nil {
		b.timer = time.AfterFunc(b.interval, b.flush)
	}
	b.mu.Unlock()
}

func (b *eventBatcher) flush() {
	b.mu.Lock()
	ps := b.pending
	b.pending, b.timer = nil, nil
	b.mu.Unlock()
	if len(ps) > 0 {
		b.emit(ps)
	}
}
