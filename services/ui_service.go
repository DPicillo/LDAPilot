package services

import (
	"context"
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/config"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// AppBeforeCloseEvent asks the frontend whether the window may close (a
// bulk run, a recursive delete or unsaved edits may be in progress). The
// frontend answers with AckClose and then calls Quit or CancelClose.
const AppBeforeCloseEvent = "app:before-close"

const (
	// closeAckTimeout: without an AckClose within this time the frontend is
	// considered dead and the window closes anyway.
	closeAckTimeout = 2 * time.Second
	// closeRepeatWindow: a second close request within this time closes the
	// window anyway (the user insists, or the guard is stuck).
	closeRepeatWindow = 5 * time.Second
)

// UIService keeps the UI state the backend needs at start-up (the resolved
// colour theme for the native window background; main.go reads it before
// the window opens) and guards closing the window (BeforeClose).
type UIService struct {
	ctx context.Context

	mu          sync.Mutex
	allowQuit   bool
	lastRequest time.Time
	answered    bool
	seq         uint64

	// Test seams; nil means the Wails runtime / real clock.
	emit  func(name string)
	quit  func()
	now   func() time.Time
	after func(d time.Duration, f func())

	build BuildInfo
}

// NewUIService creates the service.
func NewUIService() *UIService {
	return &UIService{}
}

// SetContext sets the Wails application context.
func (s *UIService) SetContext(ctx context.Context) {
	s.mu.Lock()
	s.ctx = ctx
	s.mu.Unlock()
}

// SetTheme records the theme the frontend resolved ("dark" or "light"), so
// the next start paints the native window in it before the page loads.
func (s *UIService) SetTheme(theme string) error {
	if config.LoadUIState().Theme == theme {
		return nil
	}
	return config.SaveUIState(config.UIState{Theme: theme})
}

// BeforeClose is main.go's OnBeforeClose: every way of closing the window
// (title bar button, File ▸ Exit, Alt+F4, the window manager) comes here.
// The first request is held back and the frontend gets AppBeforeCloseEvent;
// it acknowledges (AckClose) and either quits (Quit) at once, or asks the
// user first when work would be lost. Fail-safes: without an
// acknowledgement within 2 s, or on a second close request within 5 s, the
// window closes anyway.
func (s *UIService) BeforeClose(ctx context.Context) (prevent bool) {
	s.mu.Lock()
	if s.allowQuit {
		s.mu.Unlock()
		return false
	}
	now := s.clock()
	if !s.lastRequest.IsZero() && now.Sub(s.lastRequest) < closeRepeatWindow {
		s.allowQuit = true
		s.mu.Unlock()
		return false
	}
	if s.emit == nil && s.ctx == nil && ctx == nil {
		s.mu.Unlock()
		return false // no frontend to ask
	}
	if s.ctx == nil {
		s.ctx = ctx
	}
	s.lastRequest = now
	s.answered = false
	s.seq++
	seq := s.seq
	s.mu.Unlock()

	// Emit asynchronously: on Windows this runs on the UI thread, and
	// emitting evaluates JavaScript through it.
	go s.emitEvent(AppBeforeCloseEvent)
	s.schedule(closeAckTimeout, func() {
		s.mu.Lock()
		dead := s.seq == seq && !s.answered && !s.allowQuit
		if dead {
			s.allowQuit = true
		}
		s.mu.Unlock()
		if dead {
			s.doQuit()
		}
	})
	return true
}

// AckClose tells BeforeClose that the frontend received the close request
// (it decides next: Quit, or CancelClose after asking the user).
func (s *UIService) AckClose() {
	s.mu.Lock()
	s.answered = true
	s.mu.Unlock()
}

// CancelClose: the user chose to keep the window open. The next close
// request asks again.
func (s *UIService) CancelClose() {
	s.mu.Lock()
	s.answered = true
	s.lastRequest = time.Time{}
	s.mu.Unlock()
}

// Quit closes the application without asking again (File ▸ Exit after the
// frontend's check, "Quit anyway").
func (s *UIService) Quit() {
	s.mu.Lock()
	s.allowQuit = true
	s.answered = true
	s.mu.Unlock()
	s.doQuit()
}

func (s *UIService) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

func (s *UIService) schedule(d time.Duration, f func()) {
	if s.after != nil {
		s.after(d, f)
		return
	}
	time.AfterFunc(d, f)
}

func (s *UIService) emitEvent(name string) {
	if s.emit != nil {
		s.emit(name)
		return
	}
	s.mu.Lock()
	ctx := s.ctx
	s.mu.Unlock()
	if ctx != nil {
		wailsruntime.EventsEmit(ctx, name)
	}
}

func (s *UIService) doQuit() {
	if s.quit != nil {
		s.quit()
		return
	}
	s.mu.Lock()
	ctx := s.ctx
	s.mu.Unlock()
	if ctx != nil {
		wailsruntime.Quit(ctx)
	}
}
