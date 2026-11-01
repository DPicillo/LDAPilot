package provider

import (
	"context"
	"sync"
)

// Limiters bounds concurrent requests per model endpoint
// (scheme+host+port). Loopback Ollama defaults to 1 (Ollama queues
// internally), everything else to 4.
type Limiters struct {
	mu sync.Mutex
	m  map[string]*endpointLimiter
}

// DefaultLimiters is shared by all provider instances of the process.
var DefaultLimiters = NewLimiters()

// NewLimiters returns an empty limiter registry.
func NewLimiters() *Limiters { return &Limiters{m: map[string]*endpointLimiter{}} }

type endpointLimiter struct {
	mu      sync.Mutex
	limit   int
	active  int
	waiters []chan struct{}
}

// Acquire takes a slot for the endpoint. When it has to wait, onQueued is
// called once (before waiting). The returned release must be called
// exactly once.
func (l *Limiters) Acquire(ctx context.Context, endpoint string, limit int, onQueued func()) (func(), error) {
	if limit <= 0 {
		limit = 1
	}
	l.mu.Lock()
	el := l.m[endpoint]
	if el == nil {
		el = &endpointLimiter{limit: limit}
		l.m[endpoint] = el
	}
	l.mu.Unlock()
	return el.acquire(ctx, limit, onQueued)
}

func (el *endpointLimiter) acquire(ctx context.Context, limit int, onQueued func()) (func(), error) {
	el.mu.Lock()
	el.limit = limit
	if el.active < el.limit && len(el.waiters) == 0 {
		el.active++
		el.mu.Unlock()
		return el.releaser(), nil
	}
	ch := make(chan struct{})
	el.waiters = append(el.waiters, ch)
	el.mu.Unlock()
	if onQueued != nil {
		onQueued()
	}
	select {
	case <-ch:
		return el.releaser(), nil
	case <-ctx.Done():
		el.mu.Lock()
		for i, w := range el.waiters {
			if w == ch {
				el.waiters = append(el.waiters[:i], el.waiters[i+1:]...)
				el.mu.Unlock()
				return nil, ctx.Err()
			}
		}
		el.mu.Unlock()
		// The slot was handed to us concurrently: give it back.
		el.release()
		return nil, ctx.Err()
	}
}

func (el *endpointLimiter) releaser() func() {
	var once sync.Once
	return func() { once.Do(el.release) }
}

// release frees a slot, handing it directly to the oldest waiter.
func (el *endpointLimiter) release() {
	el.mu.Lock()
	defer el.mu.Unlock()
	if len(el.waiters) > 0 && el.active <= el.limit {
		ch := el.waiters[0]
		el.waiters = el.waiters[1:]
		close(ch) // the slot passes to the waiter; active stays the same
		return
	}
	el.active--
}
