package services

import (
	"context"
	"errors"
	"sync"
	"time"

	goldap "github.com/go-ldap/ldap/v3"

	"github.com/dpicillo/LDAPilot/internal/ai"
	"github.com/dpicillo/LDAPilot/internal/ai/ldaptools"
	"github.com/dpicillo/LDAPilot/internal/config"
	internalldap "github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
)

// AI backend: the ldaptools.Directory over the connection pool. This is
// the only AI file that reads models.ConnectionProfile fields (the auth
// track changes that struct); only a sanitized ConnInfo crosses into the
// harness — never the profile, whose Password field holds the bind secret.

// aiSlotsPerProfile is the AI semaphore size per profile (§3.6).
const aiSlotsPerProfile = 2

type aiDirectory struct {
	pool  *internalldap.Pool
	clock ai.Clock
	// audit records the re-lock of a disabled OpenLDAP account after an AI
	// password write (keepAccountDisabled); nil = not audited.
	audit    func(profileID, op, dn, details string, err error)
	mu       sync.Mutex
	sems     map[string]chan struct{}
	types    map[*internalldap.Client]string // server type per client (never blocks Connections)
	fetching map[*internalldap.Client]bool
}

func newAIDirectory(pool *internalldap.Pool, clock ai.Clock) *aiDirectory {
	return &aiDirectory{pool: pool, clock: clock, sems: map[string]chan struct{}{}, types: map[*internalldap.Client]string{},
		fetching: map[*internalldap.Client]bool{}}
}

// serverType returns the cached server type of a client; the first call
// reads it in the background (ServerInfo is cached by the client).
func (d *aiDirectory) serverType(c *internalldap.Client) string {
	d.mu.Lock()
	t, ok := d.types[c]
	busy := d.fetching[c]
	if !ok && !busy {
		d.fetching[c] = true
	}
	d.mu.Unlock()
	if ok || busy {
		return t
	}
	ch := make(chan string, 1)
	go func() {
		st := ""
		if si, err := c.ServerInfo(); err == nil {
			st = si.ServerType
		}
		d.mu.Lock()
		if st != "" {
			d.types[c] = st
		}
		delete(d.fetching, c)
		d.mu.Unlock()
		ch <- st
	}()
	select {
	case st := <-ch:
		return st
	case <-time.After(300 * time.Millisecond):
		return ""
	}
}

func (d *aiDirectory) sem(profileID string) chan struct{} {
	d.mu.Lock()
	defer d.mu.Unlock()
	s := d.sems[profileID]
	if s == nil {
		s = make(chan struct{}, aiSlotsPerProfile)
		d.sems[profileID] = s
	}
	return s
}

// connInfo builds the sanitized description of a connected profile.
func connInfo(c *internalldap.Client) ldaptools.ConnInfo {
	p := c.Profile()
	timeout := time.Duration(p.Timeout) * time.Second
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	info := ldaptools.ConnInfo{ProfileID: p.ID, Name: p.Name, Host: p.Host, Port: p.Port, BaseDN: p.BaseDN, TLSMode: string(p.TLSMode),
		ReadOnly: p.ReadOnly, Identity: aiIdentity(p), Timeout: timeout}
	return info
}

// aiIdentity is the approval card's "runs as": the same auth identity the
// audit log records (writeAudit), e.g. DOMAIN\user for NTLM, user@REALM or
// "(Kerberos: ticket cache)", "(client certificate)"; "anonymous" for
// anonymous binds.
func aiIdentity(p models.ConnectionProfile) string {
	id := internalldap.AuthIdentity(p)
	if p.AuthMethod == models.AuthNone || id == "" && (p.AuthMethod == "" || p.AuthMethod == models.AuthSimple) {
		return "anonymous" // a simple bind with an empty DN is anonymous too
	}
	return id
}

func (d *aiDirectory) Connections() []ldaptools.ConnInfo {
	if d.pool == nil {
		return nil
	}
	var out []ldaptools.ConnInfo
	for _, c := range d.pool.GetConnected() {
		info := connInfo(c)
		info.ServerType = d.serverType(c)
		out = append(out, info)
	}
	return out
}

func (d *aiDirectory) Client(profileID string) (ldaptools.DirClient, error) {
	if d.pool == nil {
		return nil, ldaptools.ErrNotConnected
	}
	c, err := d.pool.Get(profileID)
	if err != nil {
		return nil, ldaptools.ErrNotConnected
	}
	return &aiClient{c: c, sem: d.sem(profileID), clock: d.clock, dir: d, profileID: profileID}, nil
}

// aiClient is a DirClient; every call holds one of the profile's AI slots.
type aiClient struct {
	c         *internalldap.Client
	sem       chan struct{}
	clock     ai.Clock
	dir       *aiDirectory
	profileID string
}

func (a *aiClient) Info() ldaptools.ConnInfo {
	info := connInfo(a.c)
	info.ServerType = a.dir.serverType(a.c)
	return info
}

func (a *aiClient) acquire(ctx context.Context) error {
	select {
	case a.sem <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (a *aiClient) release() { <-a.sem }

// do runs a call without ctx support in a goroutine: the caller returns at
// the ctx deadline, the slot is held until the call really returns.
func (a *aiClient) do(ctx context.Context, fn func() error) error {
	if err := a.acquire(ctx); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() {
		defer a.release()
		done <- fn()
	}()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// write runs a write: never abandoned (the caller's ctx is a write
// context without cancellation); the profile's read-only flag is checked
// first.
func (a *aiClient) write(ctx context.Context, fn func() error) error {
	if err := a.c.CheckWritable(); err != nil {
		return err
	}
	if err := a.acquire(ctx); err != nil {
		return err
	}
	defer a.release()
	return fn()
}

func (a *aiClient) ServerInfo(ctx context.Context) (*models.ServerInfo, error) {
	var si *models.ServerInfo
	err := a.do(ctx, func() error {
		var err error
		si, err = a.c.ServerInfo()
		return err
	})
	return si, err
}

func (a *aiClient) RootDSE(ctx context.Context, attrs []string) (*models.LDAPEntry, error) {
	var out *models.LDAPEntry
	err := a.do(ctx, func() error {
		req := goldap.NewSearchRequest("", goldap.ScopeBaseObject, goldap.NeverDerefAliases, 1, 30, false, "(objectClass=*)", attrs, nil)
		es, err := a.c.SearchWithControls(req, 0)
		if err != nil {
			return err
		}
		if len(es) == 0 {
			return errors.New("RootDSE not readable")
		}
		e := &models.LDAPEntry{DN: ""}
		for _, at := range es[0].Attributes {
			e.Attributes = append(e.Attributes, models.LDAPAttribute{Name: at.Name, Values: at.Values})
		}
		out = e
		return nil
	})
	return out, err
}

func (a *aiClient) Search(ctx context.Context, p models.SearchParams) (*models.SearchResult, error) {
	if err := a.acquire(ctx); err != nil {
		return nil, err
	}
	defer a.release()
	res, err := a.c.SearchContext(ctx, p)
	return res, aiSearchErr(ctx, err)
}

// aiSearchErr maps the client's ErrSearchCancelled to the context's error
// when the tool's own context ended (deadline or run stop): SearchContext
// reports both as ErrSearchCancelled, which the tools would turn into
// SEARCH_CANCELLED ("retry") instead of TIMEOUT ("narrow the filter").
// A cancellation by LDAPilot itself (user cancel, reconnect) keeps
// ErrSearchCancelled.
func aiSearchErr(ctx context.Context, err error) error {
	if err != nil && ctx.Err() != nil && errors.Is(err, internalldap.ErrSearchCancelled) {
		return ctx.Err()
	}
	return err
}

func (a *aiClient) SearchTypesOnly(ctx context.Context, p models.SearchParams) (map[string][]string, error) {
	out := map[string][]string{}
	err := a.do(ctx, func() error {
		filter := p.Filter
		if filter == "" {
			filter = "(objectClass=*)"
		}
		req := goldap.NewSearchRequest(p.BaseDN, int(p.Scope), goldap.NeverDerefAliases, p.SizeLimit, p.TimeLimit, true, filter, []string{"*"}, nil)
		es, err := a.c.SearchWithControls(req, 0)
		if err != nil && !goldap.IsErrorWithCode(err, goldap.LDAPResultSizeLimitExceeded) {
			return err
		}
		for _, e := range es {
			names := make([]string, 0, len(e.Attributes))
			for _, at := range e.Attributes {
				names = append(names, at.Name)
			}
			out[e.DN] = names
		}
		return nil
	})
	return out, err
}

func (a *aiClient) Schema(ctx context.Context) ([]string, []string, error) {
	var at, oc []string
	err := a.do(ctx, func() error {
		dn := "cn=Subschema"
		if si, err := a.c.ServerInfo(); err == nil && si.SubschemaSubentry != "" {
			dn = si.SubschemaSubentry
		}
		req := goldap.NewSearchRequest(dn, goldap.ScopeBaseObject, goldap.NeverDerefAliases, 1, 60, false, "(objectClass=*)",
			[]string{"attributeTypes", "objectClasses"}, nil)
		es, err := a.c.SearchWithControls(req, 0)
		if err != nil {
			return err
		}
		if len(es) == 0 {
			return errors.New("schema not readable")
		}
		at = es[0].GetAttributeValues("attributeTypes")
		oc = es[0].GetAttributeValues("objectClasses")
		return nil
	})
	return at, oc, err
}

func (a *aiClient) Modify(ctx context.Context, dn string, changes []models.AttributeChange, assert string) error {
	var ctrls []goldap.Control
	if assert != "" {
		c, err := ldaptools.NewAssertionControl(assert)
		if err != nil {
			return err
		}
		ctrls = append(ctrls, c)
	}
	return a.write(ctx, func() error {
		// OpenLDAP: a password change clears the permanent ppolicy lock of a
		// disabled account; set it again (CLAUDE.md "Account status").
		guard := a.c.GuardPermanentLock(dn, changes)
		if err := a.c.ModifyEntry(dn, changes, ctrls...); err != nil {
			return err
		}
		return a.keepDisabled(guard, dn, "AI change")
	})
}

// keepDisabled is keepAccountDisabled for AI writes; the re-lock is audited
// like the editor's.
func (a *aiClient) keepDisabled(guard *internalldap.PermanentLockGuard, dn, cause string) error {
	_, err := keepAccountDisabled(guard, func(op, dn, details string, err error) {
		if a.dir != nil && a.dir.audit != nil {
			a.dir.audit(a.profileID, op, dn, details, err)
		}
	}, dn, cause)
	return err
}

func (a *aiClient) Add(ctx context.Context, dn string, attrs []models.LDAPAttribute) error {
	return a.write(ctx, func() error { return a.c.AddEntry(dn, attrs) })
}

func (a *aiClient) ModifyDN(ctx context.Context, dn, newRDN string, deleteOld bool, newSuperior string) error {
	return a.write(ctx, func() error { return a.c.RenameEntry(dn, newRDN, deleteOld, newSuperior) })
}

func (a *aiClient) Delete(ctx context.Context, dn string, assert string) error {
	var ctrls []goldap.Control
	if assert != "" {
		c, err := ldaptools.NewAssertionControl(assert)
		if err != nil {
			return err
		}
		ctrls = append(ctrls, c)
	}
	return a.write(ctx, func() error { return a.c.DeleteEntryWithControls(dn, ctrls...) })
}

// PasswordModify runs the RFC 3062 extended operation through the
// profile's own connection (Client.PasswordModify: its bind method and TLS
// trust, read-only check, PASSWD_MODIFY log entry) and keeps a disabled
// OpenLDAP account disabled, like EditorService.SetPassword without Unlock.
func (a *aiClient) PasswordModify(ctx context.Context, dn, value string) error {
	return a.write(ctx, func() error {
		guard := a.c.GuardPasswordChange(dn)
		if err := a.c.PasswordModify(dn, value); err != nil {
			return err
		}
		return a.keepDisabled(guard, dn, "AI password reset")
	})
}

// aiAuditor records AI writes and access grants in the audit log through
// writeAudit (the user field is the bind DN).
type aiAuditor struct{ s *AIService }

func (a *aiAuditor) Record(profileID, op, dn, details string, err error) {
	writeAudit(a.s.auditStore, a.s.pool, profileID, op, dn, details, err)
}

// configSource adapts the config store for the agent.
type configSource struct{ s *AIService }

func (c *configSource) Current() config.AIConfig { return c.s.configStore.Get() }

func (c *configSource) SetConnectionAccess(profileID, level, bindHost string) error {
	_, err := c.s.configStore.SetConnectionAccess(profileID, level, bindHost)
	return err
}

func (c *configSource) AllowReadHost(profileID, host string) error {
	_, err := c.s.configStore.AllowReadHost(profileID, host)
	return err
}

// facadeEmitter sends harness events through the Wails runtime.
type facadeEmitter struct{ s *AIService }

func (e facadeEmitter) Emit(name string, payload any) { e.s.emit(name, payload) }
