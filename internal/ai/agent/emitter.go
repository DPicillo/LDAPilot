package agent

import (
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ai"
)

const (
	coalesceDelay = 40 * time.Millisecond
	coalesceBytes = 2048
)

// runEmitter sends the events of one run in order: it assigns the envelope
// (chatId, runId, monotonic seq, ts) and coalesces text and thinking deltas
// per (messageId, blockIndex), flushing after 40 ms, at 2 KB or before any
// other event (§3.5).
type runEmitter struct {
	mu     sync.Mutex
	out    ai.Emitter
	clock  ai.Clock
	chatID string
	runID  string
	seq    int64
	closed bool

	buf      *ai.DeltaEvent
	bufName  string
	bufStop  chan struct{}
	onRecord func(name string, p ai.Enveloped) // snapshot bookkeeping
}

func newRunEmitter(out ai.Emitter, clock ai.Clock, chatID, runID string) *runEmitter {
	return &runEmitter{out: out, clock: clock, chatID: chatID, runID: runID}
}

// Emit sends a non-delta event (after flushing pending deltas).
func (e *runEmitter) Emit(name string, p ai.Enveloped) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.flushLocked()
	e.sendLocked(name, p)
}

func (e *runEmitter) sendLocked(name string, p ai.Enveloped) {
	if e.closed || e.out == nil {
		return
	}
	e.seq++
	p.SetEnvelope(ai.Envelope{ChatID: e.chatID, RunID: e.runID, Seq: e.seq, TS: e.clock.Now().UnixMilli()})
	if e.onRecord != nil {
		e.onRecord(name, p)
	}
	e.out.Emit(name, p)
}

// Delta queues a text or thinking delta.
func (e *runEmitter) Delta(name, messageID string, blockIndex int, text string) {
	if text == "" {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return
	}
	if e.buf != nil && (e.bufName != name || e.buf.MessageID != messageID || e.buf.BlockIndex != blockIndex) {
		e.flushLocked()
	}
	if e.buf == nil {
		e.buf = &ai.DeltaEvent{MessageID: messageID, BlockIndex: blockIndex}
		e.bufName = name
		stop := make(chan struct{})
		e.bufStop = stop
		t := e.clock.NewTimer(coalesceDelay)
		go func() {
			defer t.Stop()
			select {
			case <-t.C():
				e.mu.Lock()
				if e.bufStop == stop {
					e.flushLocked()
				}
				e.mu.Unlock()
			case <-stop:
			}
		}()
	}
	e.buf.Text += text
	if len(e.buf.Text) >= coalesceBytes {
		e.flushLocked()
	}
}

// Flush sends pending deltas.
func (e *runEmitter) Flush() {
	e.mu.Lock()
	e.flushLocked()
	e.mu.Unlock()
}

func (e *runEmitter) flushLocked() {
	if e.buf == nil {
		return
	}
	b, name := e.buf, e.bufName
	e.buf = nil
	if e.bufStop != nil {
		close(e.bufStop)
		e.bufStop = nil
	}
	e.sendLocked(name, b)
}

// Close flushes and stops emitting.
func (e *runEmitter) Close() {
	e.mu.Lock()
	e.flushLocked()
	e.closed = true
	e.mu.Unlock()
}

// LastSeq returns the last sequence number.
func (e *runEmitter) LastSeq() int64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.seq
}
