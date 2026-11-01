package services

import (
	"context"
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Shared infrastructure of bulk runs (batch modify and LDIF previews and
// applies): stoppable run registry, throttled progress events and a short
// lived schema cache for predictions.

// BulkProgressEvent is the Wails event carrying models.BulkProgress.
const BulkProgressEvent = "bulk:progress"

// bulkRun is a registered, stoppable run.
type bulkRun struct {
	cancel context.CancelFunc
}

// bulkRunRegistry maps run IDs to their cancel functions.
type bulkRunRegistry struct {
	mu   sync.Mutex
	runs map[string]*bulkRun
}

var bulkRuns = &bulkRunRegistry{runs: map[string]*bulkRun{}}

// start registers a run and returns its context and a function that must be
// called when the run ends. An empty runID gives an unregistered run.
func (r *bulkRunRegistry) start(runID string) (context.Context, func()) {
	ctx, cancel := context.WithCancel(context.Background())
	if runID == "" {
		return ctx, cancel
	}
	run := &bulkRun{cancel: cancel}
	r.mu.Lock()
	if old := r.runs[runID]; old != nil {
		old.cancel() // a reused ID stops the older run
	}
	r.runs[runID] = run
	r.mu.Unlock()
	return ctx, func() {
		r.mu.Lock()
		if r.runs[runID] == run {
			delete(r.runs, runID)
		}
		r.mu.Unlock()
		cancel()
	}
}

// stop cancels a running run; false if no run with the ID is active.
func (r *bulkRunRegistry) stop(runID string) bool {
	r.mu.Lock()
	run := r.runs[runID]
	r.mu.Unlock()
	if run == nil {
		return false
	}
	run.cancel()
	return true
}

// StopBulkRun stops a running batch modify or LDIF preview/apply started
// with BulkOptions.RunID. Entries already written stay written; the result
// of the run reports the rest as not processed. Returns false if no such run
// is active.
func (s *BatchService) StopBulkRun(runID string) bool {
	return bulkRuns.stop(runID)
}

// progressEmitter sends throttled "bulk:progress" events. It is safe for
// concurrent use; without a Wails context nothing is sent.
type progressEmitter struct {
	mu    sync.Mutex
	ctx   context.Context
	runID string
	phase string
	total int
	last  time.Time
}

func newProgressEmitter(ctx context.Context, runID, phase string, total int) *progressEmitter {
	return &progressEmitter{ctx: ctx, runID: runID, phase: phase, total: total}
}

const progressInterval = 60 * time.Millisecond

// emit sends the progress unless the last event is younger than
// progressInterval; the final item (current == total) is always sent.
func (p *progressEmitter) emit(current int, dn string, succeeded, failed, skipped int) {
	if p == nil || p.ctx == nil {
		return
	}
	p.mu.Lock()
	now := time.Now()
	if current < p.total && now.Sub(p.last) < progressInterval {
		p.mu.Unlock()
		return
	}
	p.last = now
	p.mu.Unlock()
	wailsRuntime.EventsEmit(p.ctx, BulkProgressEvent, models.BulkProgress{
		RunID: p.runID, Phase: p.phase, Current: current, Total: p.total, DN: dn,
		Succeeded: succeeded, Failed: failed, Skipped: skipped,
	})
}

// bulkSchemaCache keeps the parsed schema per profile for a few minutes, so
// previews and the following apply do not reload it.
var bulkSchemaCache = struct {
	sync.Mutex
	m map[string]bulkSchemaEntry
}{m: map[string]bulkSchemaEntry{}}

type bulkSchemaEntry struct {
	client *ldap.Client
	sc     *schemaContext
	at     time.Time
}

const bulkSchemaTTL = 10 * time.Minute

// loadSchemaContext returns the schema knowledge of the connection; when the
// schema cannot be read, predictions fall back to case-insensitive guesses.
func loadSchemaContext(client *ldap.Client, profileID string) *schemaContext {
	bulkSchemaCache.Lock()
	cached, ok := bulkSchemaCache.m[profileID]
	bulkSchemaCache.Unlock()
	if ok && cached.client == client && time.Since(cached.at) < bulkSchemaTTL {
		return cached.sc
	}

	serverType := ""
	var namingContexts []string
	if info, err := client.ServerInfo(); err == nil && info != nil {
		serverType = info.ServerType
		namingContexts = info.NamingContexts
	}
	schema, err := client.GetSchema()
	if err != nil {
		sc := newSchemaContext(nil, serverType) // not cached: retried next time
		sc.namingContexts = namingContexts
		return sc
	}
	sc := newSchemaContext(schema, serverType)
	sc.namingContexts = namingContexts
	bulkSchemaCache.Lock()
	bulkSchemaCache.m[profileID] = bulkSchemaEntry{client: client, sc: sc, at: time.Now()}
	bulkSchemaCache.Unlock()
	return sc
}
