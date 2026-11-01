package provider

import "strings"

const (
	thinkOpen      = "<think>"
	thinkClose     = "</think>"
	loneCloseProbe = 2 << 10
)

// segmentKind tells whether filtered text is answer text or reasoning.
type segmentKind int

const (
	segText segmentKind = iota
	segThinking
)

// thinkFilter is a streaming state machine that moves text inside
// <think>…</think> found in content into thinking. Tags may be split across
// chunks. When the model is known to think, the first 2 KB are held back to
// detect a lone </think> without an opening tag (the text before it is
// reasoning).
type thinkFilter struct {
	emit       func(segmentKind, string)
	inThink    bool
	buf        string // undecided tail (possible partial tag)
	probing    bool   // still deciding about a lone </think>
	probe      strings.Builder
	trimLeadNL bool // drop newlines right after </think>
}

func newThinkFilter(knownThinker bool, emit func(segmentKind, string)) *thinkFilter {
	return &thinkFilter{emit: emit, probing: knownThinker}
}

func (f *thinkFilter) push(s string) {
	if s == "" {
		return
	}
	if f.probing {
		f.probe.WriteString(s)
		p := f.probe.String()
		openIdx := strings.Index(p, thinkOpen)
		closeIdx := strings.Index(p, thinkClose)
		switch {
		case closeIdx >= 0 && (openIdx < 0 || closeIdx < openIdx):
			f.probing = false
			f.probe.Reset()
			f.out(segThinking, p[:closeIdx])
			f.trimLeadNL = true
			f.process(p[closeIdx+len(thinkClose):])
		case openIdx >= 0 || len(p) >= loneCloseProbe:
			f.probing = false
			f.probe.Reset()
			f.process(p)
		}
		return
	}
	f.process(s)
}

func (f *thinkFilter) process(s string) {
	f.buf += s
	for f.buf != "" {
		if f.inThink {
			if i := strings.Index(f.buf, thinkClose); i >= 0 {
				f.out(segThinking, f.buf[:i])
				f.buf = f.buf[i+len(thinkClose):]
				f.inThink = false
				f.trimLeadNL = true
				continue
			}
			keep := partialSuffix(f.buf, thinkClose)
			f.out(segThinking, f.buf[:len(f.buf)-keep])
			f.buf = f.buf[len(f.buf)-keep:]
			return
		}
		if i := strings.Index(f.buf, thinkOpen); i >= 0 {
			f.out(segText, f.buf[:i])
			f.buf = f.buf[i+len(thinkOpen):]
			f.inThink = true
			continue
		}
		keep := partialSuffix(f.buf, thinkOpen)
		f.out(segText, f.buf[:len(f.buf)-keep])
		f.buf = f.buf[len(f.buf)-keep:]
		return
	}
}

// stopProbing ends the lone-</think> detection and releases the probe.
func (f *thinkFilter) stopProbing() {
	if !f.probing {
		return
	}
	f.probing = false
	p := f.probe.String()
	f.probe.Reset()
	f.process(p)
}

// flush releases everything held back (end of the step).
func (f *thinkFilter) flush() {
	f.stopProbing()
	if f.buf != "" {
		kind := segText
		if f.inThink {
			kind = segThinking
		}
		f.out(kind, f.buf)
		f.buf = ""
	}
}

func (f *thinkFilter) out(kind segmentKind, s string) {
	if kind == segText && f.trimLeadNL {
		s = strings.TrimLeft(s, "\r\n")
		if s == "" {
			return
		}
		f.trimLeadNL = false
	}
	if s != "" {
		f.emit(kind, s)
	}
}

// partialSuffix returns the length of the longest suffix of s that is a
// proper prefix of tag.
func partialSuffix(s, tag string) int {
	max := len(tag) - 1
	if max > len(s) {
		max = len(s)
	}
	for n := max; n > 0; n-- {
		if strings.HasSuffix(s, tag[:n]) {
			return n
		}
	}
	return 0
}

// reasoningFilter strips a leading literal "<think>\n?" and a trailing
// "\n?</think>" from a reasoning stream (Ollama qwen3 leak).
type reasoningFilter struct {
	emit    func(string)
	started bool
	head    string // first bytes, until we know whether they start with <think>
	tail    string // held-back end (possible "\n</think>")
}

func newReasoningFilter(emit func(string)) *reasoningFilter {
	return &reasoningFilter{emit: emit}
}

func (r *reasoningFilter) push(s string) {
	if s == "" {
		return
	}
	if !r.started {
		r.head += s
		h := r.head
		if len(h) < len(thinkOpen)+1 && strings.HasPrefix(thinkOpen+"\n", h) {
			return // could still become "<think>\n"
		}
		r.started = true
		r.head = ""
		if strings.HasPrefix(h, thinkOpen) {
			h = strings.TrimPrefix(h[len(thinkOpen):], "\n")
		}
		s = h
	}
	r.tail += s
	hold := partialSuffix(r.tail, "\n"+thinkClose)
	if hold == 0 {
		hold = partialSuffix(r.tail, thinkClose)
	}
	if strings.HasSuffix(r.tail, thinkClose) {
		hold = len(thinkClose)
		if strings.HasSuffix(r.tail, "\n"+thinkClose) {
			hold++
		}
	}
	if out := r.tail[:len(r.tail)-hold]; out != "" {
		r.emit(out)
	}
	r.tail = r.tail[len(r.tail)-hold:]
}

func (r *reasoningFilter) flush() {
	if !r.started {
		r.started = true
		h := r.head
		r.head = ""
		if strings.HasPrefix(h, thinkOpen) {
			h = strings.TrimPrefix(h[len(thinkOpen):], "\n")
		}
		r.tail += h
	}
	t := strings.TrimSuffix(r.tail, thinkClose)
	if len(t) != len(r.tail) {
		t = strings.TrimSuffix(t, "\n")
	}
	r.tail = ""
	if t != "" {
		r.emit(t)
	}
}
