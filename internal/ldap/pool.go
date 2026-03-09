package ldap

import (
	"fmt"
	"sync"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// Pool manages a set of LDAP client connections keyed by profile ID.
type Pool struct {
	mu      sync.RWMutex
	clients map[string]*Client
}

// NewPool creates a new empty connection pool.
func NewPool() *Pool {
	return &Pool{
		clients: make(map[string]*Client),
	}
}

// Connect creates a new client for the given profile and establishes a connection.
// If a connection already exists for this profile, it is closed first.
func (p *Pool) Connect(profile models.ConnectionProfile) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	// Close existing connection if present
	if existing, ok := p.clients[profile.ID]; ok {
		existing.Close()
		delete(p.clients, profile.ID)
	}

	client := NewClient(profile)
	if err := client.Connect(); err != nil {
		return err
	}

	p.clients[profile.ID] = client
	return nil
}

// Disconnect closes and removes the connection for the given profile ID.
func (p *Pool) Disconnect(profileID string) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if client, ok := p.clients[profileID]; ok {
		client.Close()
		delete(p.clients, profileID)
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

// DisconnectAll closes all active connections.
func (p *Pool) DisconnectAll() {
	p.mu.Lock()
	defer p.mu.Unlock()

	for id, client := range p.clients {
		client.Close()
		delete(p.clients, id)
	}
}

// GetConnected returns a snapshot of all currently connected clients keyed by profile ID.
func (p *Pool) GetConnected() map[string]*Client {
	p.mu.RLock()
	defer p.mu.RUnlock()

	result := make(map[string]*Client, len(p.clients))
	for id, client := range p.clients {
		if client.IsConnected() {
			result[id] = client
		}
	}
	return result
}

// IsConnected returns whether a connection exists for the given profile ID.
func (p *Pool) IsConnected(profileID string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()

	client, ok := p.clients[profileID]
	if !ok {
		return false
	}
	return client.IsConnected()
}
