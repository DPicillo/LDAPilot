package provider

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

// Retry policy (§3.7).
const (
	maxRetries         = 3
	maxBackoff         = 30 * time.Second
	maxRetryAfterWait  = 60 * time.Second
	backoffJitterRatio = 0.2
)

// retrying wraps a provider with the harness retry policy. It is the only
// retry layer (the Anthropic SDK runs with retries disabled).
type retrying struct {
	Provider
	clock  ai.Clock
	jitter func() float64 // in [0,1)
}

// WithRetry wraps p: transport errors before the first byte, 408, 409, 429
// (except Anthropic spend limits), 5xx and 529, and retryable mid-stream
// errors are retried up to 3 times with exponential backoff (1 s, 2 s, 4 s,
// ±20 %, at most 30 s), honoring Retry-After. A Retry-After above 60 s fails
// at once with rate_limited. Nothing is retried once text, thinking or a
// tool call was emitted.
func WithRetry(p Provider, clock ai.Clock) Provider {
	if clock == nil {
		clock = ai.SystemClock()
	}
	return &retrying{Provider: p, clock: clock, jitter: rand.Float64}
}

func (r *retrying) Stream(ctx context.Context, req *Request, sink func(Event)) (*Response, error) {
	for attempt := 1; ; attempt++ {
		emitted := false
		wrapped := func(ev Event) {
			switch ev.Kind {
			case EvTextDelta, EvThinkingDelta, EvTextReplaced, EvToolUseStart:
				emitted = true
			}
			sink(ev)
		}
		resp, err := r.Provider.Stream(ctx, req, wrapped)
		if err == nil {
			return resp, nil
		}
		if ctx.Err() != nil {
			return resp, ctx.Err()
		}
		var pe *Error
		if !errors.As(err, &pe) || !pe.Retryable || emitted {
			return resp, err
		}
		if pe.RetryAfter > maxRetryAfterWait {
			at := r.clock.Now().Add(pe.RetryAfter)
			return resp, &Error{
				Status: pe.Status, Code: ai.CodeRateLimited, RequestID: pe.RequestID, RetryAfter: pe.RetryAfter,
				Message: fmt.Sprintf("The provider asked to wait %d s (until %s) before retrying. %s",
					int(pe.RetryAfter.Seconds()), at.Format("15:04:05"), pe.Message),
				err: err,
			}
		}
		if attempt > maxRetries {
			return resp, err
		}
		delay := r.backoff(attempt)
		if pe.RetryAfter > 0 {
			delay = pe.RetryAfter
		}
		sink(Event{Kind: EvStatus, Status: &Status{
			Kind:    ai.StatusRetrying,
			Attempt: attempt,
			DelayMs: delay.Milliseconds(),
			Message: fmt.Sprintf("%s Retrying in %.1f s (attempt %d of %d).", pe.Message, delay.Seconds(), attempt+1, maxRetries+1),
		}})
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-r.clock.After(delay):
		}
	}
}

// backoff returns min(30 s, 1 s·2^(attempt-1)) ± 20 %.
func (r *retrying) backoff(attempt int) time.Duration {
	base := time.Second << (attempt - 1)
	if base > maxBackoff || base <= 0 {
		base = maxBackoff
	}
	f := 1 + backoffJitterRatio*(2*r.jitter()-1)
	return time.Duration(float64(base) * f)
}
