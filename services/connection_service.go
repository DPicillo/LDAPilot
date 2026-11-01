package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/dpicillo/LDAPilot/internal/config"
	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// ConnectionsChangedEvent is emitted when connections.json was changed
// outside LDAPilot and the store re-read it during a write (the frontend
// reloads its profile list).
const ConnectionsChangedEvent = "connections:changed"

// ErrPasswordRequired is returned by Connect and Reconnect for a profile
// whose authentication needs a password when none is stored (imported
// profiles, a password that was never saved): the frontend asks for it and
// calls ConnectWithPassword.
var ErrPasswordRequired = errors.New("password required: no password is stored for this connection")

// passwordAskedError is the ErrPasswordRequired of a profile that asks for
// the password on every connect (ConnectionProfile.AskPassword).
type passwordAskedError struct{ name string }

func (e *passwordAskedError) Error() string {
	return fmt.Sprintf("password required: this connection asks for the password on every connect (%s)", e.name)
}

func (e *passwordAskedError) Unwrap() error { return ErrPasswordRequired }

// ConnectionService manages connection profiles and their active connections.
type ConnectionService struct {
	ctx           context.Context
	store         *config.Store
	pool          *ldap.Pool
	schemaService *SchemaService
	auditStore    *config.AuditStore

	// certMu guards certProblems: the untrusted server certificate of the
	// last failed Connect/Reconnect per profile, see GetCertificateProblem.
	certMu       sync.Mutex
	certProblems map[string]*models.CertificateProblem

	// pwMu guards sessionPasswords: passwords entered on connect without
	// "Save password" (kept in memory for reconnects until the app quits).
	pwMu             sync.Mutex
	sessionPasswords map[string]string
}

// NewConnectionService creates a new ConnectionService.
func NewConnectionService(store *config.Store, pool *ldap.Pool) *ConnectionService {
	return &ConnectionService{
		store:            store,
		pool:             pool,
		certProblems:     make(map[string]*models.CertificateProblem),
		sessionPasswords: make(map[string]string),
	}
}

// SetSchemaService sets a reference to the SchemaService for cache cleanup on disconnect.
func (s *ConnectionService) SetSchemaService(ss *SchemaService) {
	s.schemaService = ss
}

// SetAuditStore sets a reference to the AuditStore for cleanup on connection delete.
func (s *ConnectionService) SetAuditStore(store *config.AuditStore) {
	s.auditStore = store
}

// SetContext sets the Wails application context.
func (s *ConnectionService) SetContext(ctx context.Context) {
	s.ctx = ctx
	s.store.SetExternalChangeHandler(func() {
		runtime.EventsEmit(ctx, ConnectionsChangedEvent)
	})
}

// ReloadConnections re-reads connections.json (edited outside LDAPilot) and
// returns the profiles like GetConnections. Settings of connected profiles
// that apply live (read-only, page size, timeout, ...) take effect at once.
func (s *ConnectionService) ReloadConnections() ([]models.ConnectionProfile, error) {
	if err := s.store.Load(); err != nil {
		return nil, err
	}
	for _, p := range s.store.GetAll() {
		s.pool.UpdateProfile(p)
	}
	return s.GetConnections(), nil
}

// GetConnections returns all saved connection profiles. Passwords are
// never returned to the frontend; HasPassword tells whether one is stored.
func (s *ConnectionService) GetConnections() []models.ConnectionProfile {
	profiles := s.store.GetAll()
	for i := range profiles {
		profiles[i] = maskProfile(profiles[i])
	}
	return profiles
}

// GetConnection returns a single connection profile by ID, with the
// password masked like GetConnections.
func (s *ConnectionService) GetConnection(id string) (*models.ConnectionProfile, error) {
	profile, err := s.store.Get(id)
	if err != nil {
		return nil, err
	}
	masked := maskProfile(*profile)
	return &masked, nil
}

// SaveConnection creates or updates a connection profile.
// If the profile has an empty ID, a new profile is created.
// If the profile has an existing ID, it is updated, and its settings
// (read-only, page size, timeout, referrals, name, base DN) are applied to an
// open connection right away.
func (s *ConnectionService) SaveConnection(profile models.ConnectionProfile) (*models.ConnectionProfile, error) {
	if err := normalizeAuthSettings(&profile); err != nil {
		return nil, err
	}
	if err := normalizePasswordPolicySettings(&profile); err != nil {
		return nil, err
	}
	clampProfileSettings(&profile)
	if profile.ID == "" {
		// Set defaults
		if profile.Port == 0 {
			profile.Port = 389
		}
		if profile.AuthMethod == "" {
			profile.AuthMethod = models.AuthSimple
		}
		if profile.TLSMode == "" {
			profile.TLSMode = models.TLSNone
		}
		dropUnusedPassword(&profile)
		added, err := s.store.Add(profile)
		if err != nil {
			return nil, err
		}
		masked := maskProfile(*added)
		return &masked, nil
	}

	// For updates, preserve password if not provided (empty string = keep existing)
	existing, existErr := s.store.Get(profile.ID)
	if profile.Password != "" || profile.AskPassword || (existErr == nil && (existing.BindDN != profile.BindDN || existing.AuthMethod != profile.AuthMethod)) {
		// A new password or another identity: a password entered for this
		// session only no longer applies. A profile that asks on every
		// connect keeps none.
		s.setSessionPassword(profile.ID, "")
	}
	if profile.Password == "" && existErr == nil {
		profile.Password = existing.Password
	}
	dropUnusedPassword(&profile)

	saved, err := s.store.Update(profile)
	if err != nil {
		return nil, err
	}
	// Settings like read-only, page size, timeout and referral following
	// apply to a live connection immediately; host, port, TLS and bind
	// changes take effect on the next (re)connect.
	s.pool.UpdateProfile(*saved)
	masked := maskProfile(*saved)
	return &masked, nil
}

// DeleteConnection removes a connection profile by ID and disconnects if active.
// Also removes associated audit logs.
func (s *ConnectionService) DeleteConnection(id string) error {
	s.pool.Forget(id)
	s.setSessionPassword(id, "")
	if s.schemaService != nil {
		s.schemaService.ClearCache(id)
	}
	if s.auditStore != nil {
		_ = s.auditStore.DeleteForProfile(id)
	}
	return s.store.Delete(id)
}

// Connect establishes an LDAP connection for the given profile ID. If it
// fails because the server certificate is not trusted, the error message
// starts with "untrusted TLS certificate" (after the generic prefix) and
// GetCertificateProblem returns the certificate details.
//
// A profile that needs a password none is stored for fails with
// ErrPasswordRequired ("password required: …") before dialing; the frontend
// asks for it (ConnectWithPassword). A failed attempt is logged as a CONNECT
// error in the profile's operation log.
func (s *ConnectionService) Connect(profileID string) error {
	return s.connect(profileID, "")
}

// connect dials the saved profile; typed is a password typed for this
// connect ("" = the stored or this session's password).
func (s *ConnectionService) connect(profileID, typed string) error {
	profile, err := s.profileForConnect(profileID, typed)
	if err != nil {
		return err
	}
	s.streamLog(profileID)
	err = s.pool.Connect(profile)
	s.recordCertProblem(profileID, err)
	err = notePinChange(err, profile)
	if errors.Is(err, ldap.ErrBindFailed) && s.sessionPassword(profileID) != "" {
		// A wrong password typed for this session: ask again next time.
		s.setSessionPassword(profileID, "")
	}
	return err
}

// ConnectWithPassword connects a profile with a password typed by the user
// (the profile has none stored). With save the password is stored
// (encrypted) once the connection works; otherwise it is kept in memory for
// reconnects until LDAPilot quits. A profile that asks for the password on
// every connect (AskPassword) uses it for this connect only: it is neither
// saved nor kept for the next Connect / Reconnect (the open connection's
// own re-dials keep it until it is disconnected).
func (s *ConnectionService) ConnectWithPassword(profileID string, password string, save bool) error {
	if password == "" {
		return errors.New("enter the password")
	}
	profile, err := s.store.Get(profileID)
	if err != nil {
		return err
	}
	if !profileNeedsPassword(*profile) {
		return s.Connect(profileID)
	}
	if profile.AskPassword {
		return s.connect(profileID, password)
	}
	s.setSessionPassword(profileID, password)
	if err := s.Connect(profileID); err != nil {
		return err
	}
	if !save {
		return nil
	}
	if current, err := s.store.Get(profileID); err == nil {
		current.Password = password
		if saved, err := s.store.Update(*current); err == nil {
			s.setSessionPassword(profileID, "")
			s.pool.UpdateProfile(*saved)
		} else {
			return fmt.Errorf("connected, but the password could not be saved: %w", err)
		}
	}
	return nil
}

// profileForConnect returns the saved profile to dial: with typed (a
// password typed for this connect) if given, else the stored password, else
// one typed for this session; or ErrPasswordRequired. A profile that asks
// for the password on every connect only takes a typed one.
func (s *ConnectionService) profileForConnect(profileID, typed string) (models.ConnectionProfile, error) {
	profile, err := s.store.Get(profileID)
	if err != nil {
		return models.ConnectionProfile{}, err
	}
	if !profileNeedsPassword(*profile) {
		return *profile, nil
	}
	switch {
	case typed != "":
		profile.Password = typed
	case profile.AskPassword:
		profile.Password = ""
		return *profile, &passwordAskedError{name: profile.Name}
	case profile.Password == "":
		pw := s.sessionPassword(profileID)
		if pw == "" {
			return *profile, fmt.Errorf("%w (%s)", ErrPasswordRequired, profile.Name)
		}
		profile.Password = pw
	}
	return *profile, nil
}

// profileNeedsPassword reports whether the authentication of p sends a
// password (simple bind with a DN, NTLM, Kerberos with user and password).
func profileNeedsPassword(p models.ConnectionProfile) bool {
	switch p.AuthMethod {
	case models.AuthSimple:
		return strings.TrimSpace(p.BindDN) != ""
	case models.AuthNTLM:
		return true
	case models.AuthKerberos:
		return p.KrbCredSource != models.KrbCredSystem
	}
	return false
}

func (s *ConnectionService) sessionPassword(profileID string) string {
	s.pwMu.Lock()
	defer s.pwMu.Unlock()
	return s.sessionPasswords[profileID]
}

// setSessionPassword remembers (or with "" forgets) a password typed for
// this session.
func (s *ConnectionService) setSessionPassword(profileID, password string) {
	s.pwMu.Lock()
	defer s.pwMu.Unlock()
	if s.sessionPasswords == nil {
		s.sessionPasswords = make(map[string]string)
	}
	if password == "" {
		delete(s.sessionPasswords, profileID)
	} else {
		s.sessionPasswords[profileID] = password
	}
}

// streamLog forwards the profile's operation log as "operation:log" events
// (like LogService.StartLogStream), so a failed connect reaches the
// Operations panel and the status bar.
func (s *ConnectionService) streamLog(profileID string) {
	if s.ctx == nil {
		return
	}
	ctx := s.ctx
	s.pool.Logger(profileID).SetListener(func(entry ldap.LogEntry) {
		runtime.EventsEmit(ctx, "operation:log", entry)
	})
}

// Disconnect closes the LDAP connection for the given profile ID.
func (s *ConnectionService) Disconnect(profileID string) error {
	s.pool.Disconnect(profileID)
	if s.schemaService != nil {
		s.schemaService.ClearCache(profileID)
	}
	return nil
}

// TestConnection creates a temporary connection to validate settings, then
// disconnects. See TestConnectionDetailed for a structured report.
func (s *ConnectionService) TestConnection(profile models.ConnectionProfile) error {
	res := s.TestConnectionDetailed(profile)
	if !res.Success {
		return fmt.Errorf("%s", res.Error)
	}
	return nil
}

// GetConnectionStatus returns whether a connection is currently active for the given profile ID.
func (s *ConnectionService) GetConnectionStatus(profileID string) bool {
	return s.pool.IsConnected(profileID)
}

// Reconnect attempts to re-establish a connection for the given profile ID.
// Useful when a connection has been lost due to timeout or network issues.
// The new connection uses the current saved profile and replaces the old one
// atomically; if it fails, the profile is disconnected.
func (s *ConnectionService) Reconnect(profileID string) error {
	return s.Connect(profileID)
}

// PingConnection checks if the connection is still alive by performing a
// quick RootDSE read. Returns true if alive, false if dead. A dropped
// connection is transparently re-established by the read. If that re-dial
// fails because the server certificate is no longer trusted (it changed),
// the problem is recorded for GetCertificateProblem, so the connection watch
// can show the trust prompt instead of retrying; a successful ping clears it.
func (s *ConnectionService) PingConnection(profileID string) bool {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return false
	}
	// Try a lightweight RootDSE read
	_, err = client.GetRootDSE()
	var certErr *ldap.CertificateError
	if err == nil || errors.As(err, &certErr) {
		s.recordCertProblem(profileID, err)
	}
	return err == nil
}

// ExportConnections opens a save dialog and exports all connection profiles
// to a JSON file. Secrets (passwords) are never exported; they have to be
// entered again after an import. An empty Path in the result means the user
// cancelled the dialog (nothing was written).
func (s *ConnectionService) ExportConnections() (*models.ConnectionExportResult, error) {
	return s.exportConnectionsFile(s.store.GetAll())
}

// ExportSelectedConnections exports the profiles with the given IDs (in the
// order of the saved list) like ExportConnections: no secrets, an empty
// Path when the save dialog was cancelled. Unknown IDs are ignored; it fails
// when none of the IDs is a saved profile.
func (s *ConnectionService) ExportSelectedConnections(ids []string) (*models.ConnectionExportResult, error) {
	selected := selectProfiles(s.store.GetAll(), ids)
	if len(selected) == 0 {
		return nil, errors.New("no connection selected for the export")
	}
	return s.exportConnectionsFile(selected)
}

// selectProfiles returns the profiles whose ID is in ids, in list order.
func selectProfiles(all []models.ConnectionProfile, ids []string) []models.ConnectionProfile {
	want := make(map[string]bool, len(ids))
	for _, id := range ids {
		want[id] = true
	}
	var out []models.ConnectionProfile
	for _, p := range all {
		if want[p.ID] {
			out = append(out, p)
		}
	}
	return out
}

// exportConnectionsFile asks for the file and writes profiles to it.
func (s *ConnectionService) exportConnectionsFile(profiles []models.ConnectionProfile) (*models.ConnectionExportResult, error) {
	exports := exportProfiles(profiles)

	filePath, err := runtime.SaveFileDialog(s.ctx, runtime.SaveDialogOptions{
		Title:                "Export Connections",
		DefaultFilename:      "ldapilot-connections.json",
		CanCreateDirectories: true,
		Filters: []runtime.FileFilter{
			{DisplayName: "JSON Files (*.json)", Pattern: "*.json"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("dialog failed: %w", err)
	}
	if filePath == "" {
		return &models.ConnectionExportResult{}, nil // user cancelled
	}
	if err := writeConnectionExport(filePath, exports); err != nil {
		return nil, err
	}
	return &models.ConnectionExportResult{Path: filePath, Count: len(exports)}, nil
}

// writeConnectionExport writes profiles in their export form (no secrets).
func writeConnectionExport(filePath string, exports []exportProfile) error {
	data, err := json.MarshalIndent(exports, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal connections: %w", err)
	}
	if err := os.WriteFile(filePath, data, 0600); err != nil {
		return fmt.Errorf("failed to write file: %w", err)
	}
	return nil
}

// ImportConnections opens a file dialog and imports connection profiles from
// a JSON file written by ExportConnections. It reports what was imported,
// which profiles were skipped as duplicates (same host, port, bind DN and
// base DN as a saved profile) and which could not be imported, and why.
// Plaintext passwords in files written by older versions are still imported
// (and encrypted at rest); every other imported profile that needs a
// password asks for it on its first connect.
func (s *ConnectionService) ImportConnections() (*models.ConnectionImportReport, error) {
	filePath, err := runtime.OpenFileDialog(s.ctx, runtime.OpenDialogOptions{
		Title: "Import Connections",
		Filters: []runtime.FileFilter{
			{DisplayName: "JSON Files (*.json)", Pattern: "*.json"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("dialog failed: %w", err)
	}
	if filePath == "" {
		return &models.ConnectionImportReport{Cancelled: true}, nil
	}
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}
	report, err := s.importConnectionData(data)
	if err != nil {
		return nil, err
	}
	report.Path = filePath
	return report, nil
}

// importConnectionData imports the profiles of an export file (see
// ImportConnections).
func (s *ConnectionService) importConnectionData(data []byte) (*models.ConnectionImportReport, error) {
	var imports []exportProfile
	if err := json.Unmarshal(data, &imports); err != nil {
		return nil, fmt.Errorf("not a connection export file (invalid JSON: %v)", err)
	}
	report := &models.ConnectionImportReport{
		Total:        len(imports),
		Imported:     []string{},
		Duplicates:   []string{},
		Skipped:      []models.ConnectionImportSkip{},
		NeedPassword: []string{},
		AskPassword:  []string{},
	}
	seen := map[string]bool{}
	for _, p := range s.store.GetAll() {
		seen[profileIdentityKey(p)] = true
	}
	for i, imp := range imports {
		name := strings.TrimSpace(imp.Name)
		if name == "" {
			name = fmt.Sprintf("Profile %d", i+1)
		}
		if strings.TrimSpace(imp.Host) == "" {
			report.Skipped = append(report.Skipped, models.ConnectionImportSkip{Name: name, Reason: "no host"})
			continue
		}
		profile := importProfile(imp)
		profile.Name = name
		if err := normalizeAuthSettings(&profile); err != nil {
			report.Skipped = append(report.Skipped, models.ConnectionImportSkip{Name: name, Reason: err.Error()})
			continue
		}
		clampProfileSettings(&profile)
		key := profileIdentityKey(profile)
		if seen[key] {
			report.Duplicates = append(report.Duplicates, name)
			continue
		}
		dropUnusedPassword(&profile)
		if _, err := s.store.Add(profile); err != nil {
			report.Skipped = append(report.Skipped, models.ConnectionImportSkip{Name: name, Reason: err.Error()})
			continue
		}
		seen[key] = true
		report.Imported = append(report.Imported, name)
		switch {
		case !profileNeedsPassword(profile):
		case profile.AskPassword:
			report.AskPassword = append(report.AskPassword, name)
		case profile.Password == "":
			report.NeedPassword = append(report.NeedPassword, name)
		}
	}
	return report, nil
}

// profileIdentityKey identifies the directory and account a profile
// connects to: host (case-insensitive), port, bind DN and base DN
// (case- and blank-insensitive). Import treats profiles with the same key as
// duplicates.
func profileIdentityKey(p models.ConnectionProfile) string {
	norm := func(v string) string { return strings.ToLower(strings.Join(strings.Fields(v), "")) }
	return strings.Join([]string{norm(p.Host), fmt.Sprint(p.Port), norm(p.BindDN), norm(p.BaseDN)}, "\x00")
}

// clampProfileSettings keeps page size and timeout in their valid ranges
// (ldap.MinProfile*/MaxProfile*); unset or invalid values get the defaults.
func clampProfileSettings(p *models.ConnectionProfile) {
	switch {
	case p.PageSize <= 0:
		p.PageSize = 500
	case p.PageSize > ldap.MaxProfilePageSize:
		p.PageSize = ldap.MaxProfilePageSize
	}
	switch {
	case p.Timeout <= 0:
		p.Timeout = 10
	case p.Timeout > ldap.MaxProfileTimeout:
		p.Timeout = ldap.MaxProfileTimeout
	}
}
