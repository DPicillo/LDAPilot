package ldap

import (
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// Pool manages a set of LDAP client connections keyed by profile ID.
//
// The pool lock only guards the maps; it is never held while dialing,
// binding or closing, so a slow or unreachable server does not block
// operations on other profiles.
type Pool struct {
	mu      sync.RWMutex
	clients map[string]*Client
	// gens counts Connect/Disconnect calls per profile; a dial that finishes
	// after a newer call for the same profile is discarded.
	gens map[string]uint64
	// settings holds the latest profile per ID given to Connect or
	// UpdateProfile, so a client that finishes dialing picks up settings
	// saved while it was dialing.
	settings map[string]models.ConnectionProfile
	// attempts holds the newest Connect per profile until the next Connect
	// or Disconnect; a superseded Connect returns its result.
	attempts map[string]*connectAttempt
	// loggers is the operation log of each profile. It outlives its clients
	// (failed connects, disconnects, reconnects), so a failed CONNECT stays
	// in the profile's log and its event listener keeps streaming.
	loggers map[string]*Logger
}

// connectAttempt is a Pool.Connect call; err is valid once done is closed.
type connectAttempt struct {
	done chan struct{}
	err  error
}

// NewPool creates a new empty connection pool.
func NewPool() *Pool {
	return &Pool{
		clients:  make(map[string]*Client),
		gens:     make(map[string]uint64),
		settings: make(map[string]models.ConnectionProfile),
		attempts: make(map[string]*connectAttempt),
		loggers:  make(map[string]*Logger),
	}
}

// Logger returns the operation log of a profile, creating it on first use.
// Clients of the profile log into it; it survives failed connects and
// disconnects (dropped by Forget).
func (p *Pool) Logger(profileID string) *Logger {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.loggerLocked(profileID)
}

func (p *Pool) loggerLocked(profileID string) *Logger {
	if p.loggers == nil {
		p.loggers = make(map[string]*Logger)
	}
	l := p.loggers[profileID]
	if l == nil {
		l = NewLogger()
		p.loggers[profileID] = l
	}
	l.setProfile(profileID)
	return l
}

// Forget disconnects a profile and drops its operation log (the profile was
// deleted).
func (p *Pool) Forget(profileID string) {
	p.Disconnect(profileID)
	p.mu.Lock()
	delete(p.loggers, profileID)
	p.mu.Unlock()
}

// Connect creates a new client for the given profile and establishes a connection.
// If a connection already exists for this profile, it keeps serving requests
// while the new one is dialed and is closed once the new client has been
// swapped in; the new client continues the operation log of the old one.
// If connecting fails, the profile ends up disconnected.
//
// Overlapping calls for the same profile are resolved in favour of the
// newest one: an older call that finishes later discards its own connection
// and returns the result of the newest call, so all of them report the state
// the profile ends up in. If the profile is disconnected meanwhile, it
// returns ErrConnectCancelled.
func (p *Pool) Connect(profile models.ConnectionProfile) error {
	attempt := &connectAttempt{done: make(chan struct{})}
	p.mu.Lock()
	p.gens[profile.ID]++
	gen := p.gens[profile.ID]
	prev := p.clients[profile.ID]
	p.settings[profile.ID] = profile
	p.attempts[profile.ID] = attempt
	if prev != nil && p.loggers[profile.ID] == nil {
		p.loggers[profile.ID] = prev.logger
	}
	logger := p.loggerLocked(profile.ID)
	p.mu.Unlock()

	attempt.err = p.connect(profile, gen, logger)
	close(attempt.done)
	return attempt.err
}

// connect dials a client for profile and installs it unless a newer Connect
// or a Disconnect for the profile happened meanwhile (gen changed). A failed
// attempt is logged as a CONNECT error in the profile's operation log.
func (p *Pool) connect(profile models.ConnectionProfile, gen uint64, logger *Logger) error {
	start := time.Now()
	client := NewClient(profile)
	client.logger = logger
	err := client.Connect()

	p.mu.Lock()
	if p.gens[profile.ID] != gen {
		// A newer Connect or a Disconnect for this profile won the race.
		newer := p.attempts[profile.ID]
		p.mu.Unlock()
		client.Close()
		if newer == nil {
			return ErrConnectCancelled
		}
		// Newer attempts never wait for older ones, so this cannot deadlock.
		<-newer.done
		return newer.err
	}
	old := p.clients[profile.ID]
	if err != nil {
		delete(p.clients, profile.ID)
		delete(p.settings, profile.ID)
	} else {
		p.clients[profile.ID] = client
		if settings, ok := p.settings[profile.ID]; ok {
			client.applySettings(settings)
		}
	}
	p.mu.Unlock()

	if old != nil {
		old.Close()
	}
	if err != nil && !errors.Is(err, ErrConnectCancelled) {
		// Outside the pool lock: the logger's listener emits a UI event.
		address := net.JoinHostPort(profile.Host, strconv.Itoa(profile.Port))
		logger.Log("CONNECT", fmt.Sprintf("Connection to %s failed", address), time.Since(start), err)
	}
	return err
}

// Disconnect closes and removes the connection for the given profile ID.
// A Connect for the same profile that is still dialing is discarded and
// returns ErrConnectCancelled.
func (p *Pool) Disconnect(profileID string) {
	p.mu.Lock()
	p.gens[profileID]++
	client := p.clients[profileID]
	delete(p.clients, profileID)
	delete(p.settings, profileID)
	delete(p.attempts, profileID)
	p.mu.Unlock()

	if client != nil {
		client.Close()
	}
}

// UpdateProfile applies the settings of a saved profile to its live
// connection, if any, without reconnecting: read-only flag, page size,
// timeout, referral following, name, base DN and the password storage
// policy take effect immediately.
// Changes of the connection identity (host, port, TLS, bind DN, password,
// auth method) only take effect with the next Connect (Reconnect).
func (p *Pool) UpdateProfile(profile models.ConnectionProfile) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, dialing := p.settings[profile.ID]; dialing || p.clients[profile.ID] != nil {
		p.settings[profile.ID] = profile
	}
	if client := p.clients[profile.ID]; client != nil {
		client.applySettings(profile)
	}
}

// Get returns the Client for the given profile ID, or an error if not connected.
func (p *Pool) Get(profileID string) (*Client, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	client, ok := p.clients[profileID]
	if !ok {
		return nil, fmt.Errorf("%w: profile %s", ErrNotConnected, profileID)
	}
	return client, nil
}

// DisconnectAll closes all active connections. Connects still dialing are
// discarded like with Disconnect.
func (p *Pool) DisconnectAll() {
	p.mu.Lock()
	clients := make([]*Client, 0, len(p.clients))
	for id, client := range p.clients {
		p.gens[id]++
		clients = append(clients, client)
	}
	for id := range p.settings {
		if p.clients[id] == nil {
			// Connect still dialing for this profile.
			p.gens[id]++
		}
	}
	clear(p.clients)
	clear(p.settings)
	clear(p.attempts)
	p.mu.Unlock()

	for _, client := range clients {
		client.Close()
	}
}

// GetConnected returns a snapshot of all currently connected clients keyed by profile ID.
func (p *Pool) GetConnected() map[string]*Client {
	p.mu.RLock()
	snapshot := make(map[string]*Client, len(p.clients))
	for id, client := range p.clients {
		snapshot[id] = client
	}
	p.mu.RUnlock()

	for id, client := range snapshot {
		if !client.IsConnected() {
			delete(snapshot, id)
		}
	}
	return snapshot
}

// IsConnected returns whether a connection exists for the given profile ID.
func (p *Pool) IsConnected(profileID string) bool {
	p.mu.RLock()
	client, ok := p.clients[profileID]
	p.mu.RUnlock()

	if !ok {
		return false
	}
	return client.IsConnected()
}
