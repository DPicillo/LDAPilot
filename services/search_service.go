package services

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"

	internalldap "github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
)

// SearchService provides LDAP search capabilities.
type SearchService struct {
	ctx  context.Context
	pool *internalldap.Pool

	// running holds the cancel funcs of in-flight searches per profile ID.
	mu      sync.Mutex
	running map[string]map[uint64]context.CancelFunc
	seq     uint64
	// runs holds the SearchRun calls by run ID (results tabs).
	runs map[string]trackedRun
}

// trackedRun is one SearchRun in flight (id tells a newer run of the same run ID apart).
type trackedRun struct {
	id     uint64
	cancel context.CancelFunc
}

// NewSearchService creates a new SearchService.
func NewSearchService(pool *internalldap.Pool) *SearchService {
	return &SearchService{
		pool:    pool,
		running: make(map[string]map[uint64]context.CancelFunc),
		runs:    make(map[string]trackedRun),
	}
}

// SetContext sets the Wails application context.
func (s *SearchService) SetContext(ctx context.Context) {
	s.ctx = ctx
}

// Search performs an LDAP search with the given parameters.
// It can be stopped with CancelSearch and then fails with
// ldap.ErrSearchCancelled ("search cancelled").
func (s *SearchService) Search(profileID string, params models.SearchParams) (*models.SearchResult, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	ctx, done := s.track(profileID)
	defer done()
	return client.SearchContext(ctx, params)
}

// CancelSearch cancels all searches started through Search for the given
// profile that are still running. Searches run internally by other services
// (export, AI, statistics) are not affected. Returns the number of searches
// cancelled.
func (s *SearchService) CancelSearch(profileID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, cancel := range s.running[profileID] {
		cancel()
	}
	return len(s.running[profileID])
}

// track registers a cancellable context for a search of profileID. The
// returned func must be called when the search has finished.
func (s *SearchService) track(profileID string) (context.Context, func()) {
	ctx, cancel := context.WithCancel(context.Background())

	s.mu.Lock()
	s.seq++
	id := s.seq
	if s.running[profileID] == nil {
		s.running[profileID] = make(map[uint64]context.CancelFunc)
	}
	s.running[profileID][id] = cancel
	s.mu.Unlock()

	return ctx, func() {
		s.mu.Lock()
		delete(s.running[profileID], id)
		if len(s.running[profileID]) == 0 {
			delete(s.running, profileID)
		}
		s.mu.Unlock()
		cancel()
	}
}

// SearchRun is Search with a caller-chosen run ID: CancelSearchRun(runID)
// stops it, CancelSearch(profileID) does not. A results tab re-runs its own
// search with it, so cancelling that re-run never cancels the search the
// panel runs at the same time on the same connection (and vice versa).
func (s *SearchService) SearchRun(profileID, runID string, params models.SearchParams) (*models.SearchResult, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	ctx, done := s.trackRun(runID)
	defer done()
	return client.SearchContext(ctx, params)
}

// CancelSearchRun cancels the SearchRun with this run ID; false when none
// runs (finished, or not started yet).
func (s *SearchService) CancelSearchRun(runID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.runs[runID]
	if ok {
		run.cancel()
	}
	return ok
}

// trackRun registers a cancellable context under runID (a run ID used twice
// cancels the older run). The returned func must be called when done.
func (s *SearchService) trackRun(runID string) (context.Context, func()) {
	ctx, cancel := context.WithCancel(context.Background())
	if runID == "" {
		return ctx, cancel
	}
	s.mu.Lock()
	if old, ok := s.runs[runID]; ok {
		old.cancel()
	}
	s.seq++
	id := s.seq
	s.runs[runID] = trackedRun{id: id, cancel: cancel}
	s.mu.Unlock()
	return ctx, func() {
		s.mu.Lock()
		// A newer run with the same ID keeps its entry.
		if cur, ok := s.runs[runID]; ok && cur.id == id {
			delete(s.runs, runID)
		}
		s.mu.Unlock()
		cancel()
	}
}

// maxReadEntries caps ReadEntries (one base read per DN).
const maxReadEntries = 5000

// ReadEntriesResult is the outcome of ReadEntries.
type ReadEntriesResult struct {
	// Entries in the order of the requested DNs (duplicates read once).
	Entries []models.LDAPEntry `json:"entries"`
	// Missing lists the DNs that do not exist (noSuchObject).
	Missing []string `json:"missing"`
	// Errors lists the DNs that could not be read, with the reason.
	Errors []BatchError `json:"errors"`
	// Truncated is set when more than maxReadEntries DNs were asked for.
	Truncated bool `json:"truncated"`
}

// ReadEntries reads a list of entries by DN with the given attributes (empty
// = all user attributes): one base read per DN, not logged per entry (a
// background read, like the result rows' status re-reads). "Open in List"
// after an LDIF import or a bulk run shows the touched entries with it. A
// DN that does not exist is listed in Missing, other failures in Errors; a
// lost connection fails the whole call.
func (s *SearchService) ReadEntries(profileID string, dns []string, attributes []string) (*ReadEntriesResult, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return readEntries(client, dns, attributes)
}

// attributeReader is the read access ReadEntries needs (*ldap.Client).
type attributeReader interface {
	ReadAttributes(dn string, names []string) (map[string]models.LDAPAttribute, error)
}

func readEntries(r attributeReader, dns []string, attributes []string) (*ReadEntriesResult, error) {
	names := attributes
	if len(names) == 0 {
		names = []string{"*"}
	}
	out := &ReadEntriesResult{Entries: []models.LDAPEntry{}, Missing: []string{}, Errors: []BatchError{}}
	seen := make(map[string]bool, len(dns))
	for _, raw := range dns {
		dn := strings.TrimSpace(raw)
		key := batchDNKey(dn)
		if dn == "" || seen[key] {
			continue
		}
		if len(seen) >= maxReadEntries {
			out.Truncated = true
			break
		}
		seen[key] = true
		attrs, err := r.ReadAttributes(dn, names)
		switch {
		case err != nil && goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchObject):
			out.Missing = append(out.Missing, dn)
		case err != nil && errors.Is(err, internalldap.ErrNotConnected):
			return nil, err
		case err != nil:
			out.Errors = append(out.Errors, BatchError{DN: dn, Message: err.Error()})
		case len(attrs) == 0:
			// A base read without any attribute: the entry is gone or hidden by ACLs.
			out.Missing = append(out.Missing, dn)
		default:
			out.Entries = append(out.Entries, models.LDAPEntry{DN: dn, Attributes: sortedAttributes(attrs)})
		}
	}
	return out, nil
}

// sortedAttributes lists the attributes of a ReadAttributes map: objectClass
// first, then by name (the map has no order).
func sortedAttributes(m map[string]models.LDAPAttribute) []models.LDAPAttribute {
	list := make([]models.LDAPAttribute, 0, len(m))
	for _, a := range m {
		list = append(list, a)
	}
	sort.SliceStable(list, func(i, j int) bool {
		oi, oj := strings.EqualFold(list[i].Name, "objectClass"), strings.EqualFold(list[j].Name, "objectClass")
		if oi != oj {
			return oi
		}
		return strings.ToLower(list[i].Name) < strings.ToLower(list[j].Name)
	})
	return list
}

// ValidateFilter checks whether the given LDAP filter string is syntactically valid.
func (s *SearchService) ValidateFilter(filter string) error {
	return internalldap.ValidateFilter(filter)
}
