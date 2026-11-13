package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/ldif"
	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// LDIF change files (RFC 2849): dry run with existence checks and
// simulation, apply with continue-on-error, file dialogs.

const (
	// maxLDIFFileSize caps LDIF files opened through OpenLDIFFile.
	maxLDIFFileSize = 64 << 20
	// maxLDIFURLTotal caps the sum of all "attr:< file://" values of a file.
	maxLDIFURLTotal = 64 << 20
)

// parseLDIFChanges parses content with local file:// URL support.
func parseLDIFChanges(content string) *ldif.ParseResult {
	return ldif.ParseChanges(content, ldif.ParseOptions{ResolveURL: ldif.FileURLResolver(ldif.DefaultMaxURLValueSize, maxLDIFURLTotal)})
}

// PreviewLDIFChanges is the dry run of an LDIF file with content and change
// records. It validates the whole file (syntax errors with line numbers, DN
// syntax) and checks every record against the directory, taking the effect
// of earlier records into account: add targets must not exist and need an
// existing parent, modify/delete/modrdn targets must exist, modrdn targets
// must be free and newsuperior must exist; modify records are simulated
// (see BatchPreview) and show attribute diffs. Nothing is written.
// options.RunID allows StopBulkRun and progress events (phase "preview").
func (s *ExportService) PreviewLDIFChanges(profileID string, content string, options models.BulkOptions) (*models.LDIFPreview, error) {
	parsed := parseLDIFChanges(content)
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	set, err := newLDIFImportSettings(client, options.Import)
	if err != nil {
		return nil, err
	}
	sc := loadSchemaContext(client, profileID)
	sim := newLDIFSimulator(client, sc, set)
	if ldifHasPasswords(parsed) {
		eff, err := client.PasswordPolicy()
		if err != nil {
			return nil, err
		}
		sim.passwords = &ldifPasswordPlanning{policy: *eff, opts: options.Passwords}
	}

	ctx, done := bulkRuns.start(options.RunID)
	defer done()
	progress := newProgressEmitter(s.ctx, options.RunID, "preview", len(parsed.Records))

	sim.prefetch(ctx, parsed.Records, func(done, total int) {
		progress.emit(0, fmt.Sprintf("checking the directory: %d of %d reads", done, total), 0, 0, 0)
	})
	preview, stopped := buildLDIFPreview(parsed, sim, func(i int, rp *models.LDIFRecordPreview) bool {
		if ctx.Err() != nil {
			return false
		}
		progress.emit(i+1, rp.DN, 0, 0, 0)
		return true
	})
	preview.Stopped = stopped
	preview.ServerType = set.serverType
	preview.Notes = ldifFileNotes(parsed, set)
	if sim.passwords != nil {
		preview.Passwords = sim.passwords.merged
	}
	keepLDIFPreview(options.RunID, preview, content)
	return preview, nil
}

// buildLDIFPreview checks all records with sim. next is called after every
// record and returns false to stop.
func buildLDIFPreview(parsed *ldif.ParseResult, sim *ldifSimulator, next func(i int, rp *models.LDIFRecordPreview) bool) (*models.LDIFPreview, bool) {
	preview := &models.LDIFPreview{
		Version:      parsed.Version,
		Records:      make([]models.LDIFRecordPreview, 0, len(parsed.Records)),
		SyntaxErrors: make([]models.LDIFSyntaxError, 0, len(parsed.Errors)),
		ByChangeType: map[string]int{},
		ByStatus:     map[string]int{},
		Notes:        []string{},
	}
	for _, e := range parsed.Errors {
		preview.SyntaxErrors = append(preview.SyntaxErrors, models.LDIFSyntaxError{Line: e.Line, Message: e.Msg})
	}
	var totals ldifAdjustmentTotals
	sim.prepare(parsed.Records)
	stopped := false
	for i := range parsed.Records {
		rec := &parsed.Records[i]
		rp := sim.check(i, rec)
		totals.add(rp.Adjustments)
		preview.Records = append(preview.Records, rp)
		if rp.ChangeType != "" {
			preview.ByChangeType[rp.ChangeType]++
		}
		preview.ByStatus[rp.Status]++
		if next != nil && !next(i, &rp) && i+1 < len(parsed.Records) {
			stopped = true
			break
		}
	}
	preview.Total = len(parsed.Records)
	preview.Applicable = len(parsed.Errors) == 0 && len(parsed.Records) > 0
	preview.Adjustments = totals.list()
	return preview, stopped
}

// ldifFileNotes are notes about the whole file on the server: an import of
// accounts into Active Directory without passwords (AD never exports them).
func ldifFileNotes(parsed *ldif.ParseResult, set ldifImportSettings) []string {
	notes := []string{}
	if set.serverType != models.ServerTypeAD {
		return notes
	}
	accounts := 0
	for i := range parsed.Records {
		rec := &parsed.Records[i]
		if rec.ChangeType != models.LDIFChangeAdd || rec.Err != nil {
			continue
		}
		user, pw := false, false
		for _, a := range rec.Attributes {
			if strings.EqualFold(a.Name, "objectClass") {
				for _, v := range a.Values {
					user = user || strings.EqualFold(v, "user")
				}
			}
			pw = pw || (ldap.IsUnicodePwdAttribute(a.Name) && len(a.Values) > 0)
		}
		if user && !pw {
			accounts++
		}
	}
	if accounts > 0 {
		n := "1 account is"
		if accounts > 1 {
			n = fmt.Sprintf("%d accounts are", accounts)
		}
		notes = append(notes, n+" created without a password: Active Directory never returns passwords (unicodePwd can only be written), so an export from AD has none. Set them afterwards with Reset Password, or add unicodePwd lines (needs LDAPS or StartTLS).")
	}
	return notes
}

// entryReader is the read access the LDIF simulator needs (*ldap.Client).
type entryReader interface {
	EntryExists(dn string) (bool, error)
	GetEntry(dn string) (*models.LDAPEntry, error)
	// ChildDNs returns up to limit direct children of dn; truncated is
	// true when there are more.
	ChildDNs(dn string, limit int) (dns []string, truncated bool, err error)
}

// valueOwnerReader is implemented by readers that can find the entries
// holding a value (ldap.Client): the dry run predicts AD's unique-value
// checks with it. Optional, so test directories need not implement it.
type valueOwnerReader interface {
	DNsWithValue(base, attr, value string, limit int) ([]string, error)
}

// adUniqueAttributes are kept unique per domain by AD / Samba (an add with a
// value in use fails with entryAlreadyExists, e.g. "samldb: sAMAccountName
// 'x' already in use"); predicted as errors. userPrincipalName is unique
// forest-wide on Windows 2012 R2+ but not on every Samba version: a warning.
var adUniqueAttributes = []struct {
	name  string
	error bool
}{{"sAMAccountName", true}, {"userPrincipalName", false}}

// maxLeafCheckChildren caps the server children read to decide whether a
// deleted entry is still a leaf after the earlier records.
const maxLeafCheckChildren = 1000

// ldifSimEntry is the simulated state of a DN touched by the file.
type ldifSimEntry struct {
	exists bool
	entry  *models.LDAPEntry // nil when not loaded
}

// ldifSubtreeOp records a delete or rename, so that DNs below it can be
// mapped to their server DN (or recognized as gone).
type ldifSubtreeOp struct {
	rename bool
	oldDN  *goldap.DN
	newDN  *goldap.DN // rename only
}

// ldifSimulator checks records in file order against the directory plus the
// simulated effect of the earlier records.
type ldifSimulator struct {
	r      entryReader
	sc     *schemaContext
	known  map[string]*ldifSimEntry // bulkDNKey -> state
	ops    []ldifSubtreeOp
	exists map[string]bool // server existence cache by bulkDNKey of the server DN
	// unique: AD unique values (attribute|lower value) taken by earlier add
	// records of the file -> their DN.
	unique map[string]string

	// passwords plans the userPassword values of add and modify records
	// (nil: the file has none).
	passwords *ldifPasswordPlanning

	// set are the import options of the run (what add records adapt).
	set ldifImportSettings
	// failed: DNs (bulkDNKey) whose add record failed during apply → its
	// line; later records of the entry or below it are not sent.
	failed map[string]int
	// addAt: DNs (bulkDNKey) of the file's add records → record index
	// (prepare); current is the index of the record being planned.
	addAt   map[string]int
	current int
	// owners caches the AD unique-value lookups (attribute|lower value →
	// DNs holding it), filled by prefetch.
	owners map[string][]string
	// keys caches bulkDNKey (DN parsing dominated the planning of large files).
	keys map[string]string
}

// key is bulkDNKey of dn, cached for the run.
func (s *ldifSimulator) key(dn string) string {
	if k, ok := s.keys[dn]; ok {
		return k
	}
	k := bulkDNKey(dn)
	if len(s.keys) < 1<<21 {
		s.keys[dn] = k
	}
	return k
}

func newLDIFSimulator(r entryReader, sc *schemaContext, set ldifImportSettings) *ldifSimulator {
	if sc == nil {
		sc = newSchemaContext(nil, "")
	}
	if opts, err := normalizeLDIFImportOptions(set.opts); err == nil {
		set.opts = opts
	}
	return &ldifSimulator{r: r, sc: sc, set: set, known: map[string]*ldifSimEntry{}, exists: map[string]bool{}, unique: map[string]string{}, failed: map[string]int{}, owners: map[string][]string{}, keys: map[string]string{}}
}

// ldifWrite is what apply sends for a record, as planned by the simulator.
type ldifWrite struct {
	action string // ldifWrite* constants
	// attrs and controls of an add (adapted), changes of an update.
	attrs    []models.LDAPAttribute
	controls []goldap.Control
	changes  []models.AttributeChange
	// entry is the existing entry an update was planned against.
	entry *models.LDAPEntry
	// deferred are value adds sent at the end of the run (DN values of
	// entries a later record creates, Active Directory).
	deferred []models.AttributeChange
	// undo reverts the simulated effect of the record when its write fails.
	undo func()
}

const (
	ldifWriteSend      = ""          // send the record (as adapted)
	ldifWriteUpdate    = "update"    // add record of an existing entry: modify it
	ldifWriteSkip      = "skip"      // add record of an existing entry: leave it alone
	ldifWriteUnchanged = "unchanged" // add record of an existing entry that has the values already
	ldifWriteBlocked   = "blocked"   // not sent (rp.Errors say why)
)

// serverDN maps a DN as seen after the earlier records to the DN of the
// same entry on the server; gone is true when the entry was deleted or
// moved away by an earlier record.
func (s *ldifSimulator) serverDN(dn string) (string, bool) {
	if len(s.ops) == 0 {
		return dn, false
	}
	parsed, err := goldap.ParseDN(dn)
	if err != nil {
		return dn, false
	}
	changed := false
	for j := len(s.ops) - 1; j >= 0; j-- {
		op := s.ops[j]
		if op.rename {
			if op.newDN.EqualFold(parsed) || op.newDN.AncestorOfFold(parsed) {
				parsed = replaceDNSuffix(parsed, len(op.newDN.RDNs), op.oldDN)
				changed = true
				continue
			}
			if op.oldDN.EqualFold(parsed) || op.oldDN.AncestorOfFold(parsed) {
				return "", true
			}
			continue
		}
		if op.oldDN.EqualFold(parsed) || op.oldDN.AncestorOfFold(parsed) {
			return "", true
		}
	}
	if !changed {
		return dn, false
	}
	return parsed.String(), false
}

// replaceDNSuffix replaces the last suffixLen RDNs of dn with newSuffix.
func replaceDNSuffix(dn *goldap.DN, suffixLen int, newSuffix *goldap.DN) *goldap.DN {
	out := &goldap.DN{}
	out.RDNs = append(out.RDNs, dn.RDNs[:len(dn.RDNs)-suffixLen]...)
	out.RDNs = append(out.RDNs, newSuffix.RDNs...)
	return out
}

// entryExists reports whether dn exists after the earlier records.
func (s *ldifSimulator) entryExists(dn string) (bool, error) {
	if st, ok := s.known[s.key(dn)]; ok {
		return st.exists, nil
	}
	sdn, gone := s.serverDN(dn)
	if gone {
		return false, nil
	}
	key := s.key(sdn)
	if v, ok := s.exists[key]; ok {
		return v, nil
	}
	found, err := s.r.EntryExists(sdn)
	if err != nil {
		return false, err
	}
	s.exists[key] = found
	return found, nil
}

// currentDN maps a server DN to the DN of the same entry after the earlier
// records; ok is false when the entry was deleted by an earlier record.
func (s *ldifSimulator) currentDN(serverDN string) (*goldap.DN, bool) {
	parsed, err := goldap.ParseDN(serverDN)
	if err != nil {
		return nil, false
	}
	for _, op := range s.ops {
		if !op.oldDN.EqualFold(parsed) && !op.oldDN.AncestorOfFold(parsed) {
			continue
		}
		if !op.rename {
			return nil, false
		}
		parsed = replaceDNSuffix(parsed, len(op.oldDN.RDNs), op.newDN)
	}
	return parsed, true
}

// hasChildren reports whether the existing entry dn has child entries after
// the earlier records: entries the file added or moved below it, or server
// children the file did not delete or move away. LDAP delete only removes
// leaf entries (notAllowedOnNonLeaf otherwise).
func (s *ldifSimulator) hasChildren(dn string) (bool, error) {
	parsed, err := goldap.ParseDN(dn)
	if err != nil {
		return false, nil
	}
	for key, st := range s.known {
		if !st.exists {
			continue
		}
		if kp, err := goldap.ParseDN(key); err == nil && parsed.AncestorOfFold(kp) {
			return true, nil
		}
	}
	sdn, gone := s.serverDN(dn)
	if gone {
		return false, nil
	}
	// Every earlier record removes at most one direct child (a delete or a
	// rename away), so more server children than records means at least
	// one is left.
	limit := len(s.ops) + 1
	if limit > maxLeafCheckChildren {
		limit = maxLeafCheckChildren
	}
	children, truncated, err := s.r.ChildDNs(sdn, limit)
	if err != nil {
		return false, err
	}
	for _, c := range children {
		if cur, ok := s.currentDN(c); ok && len(cur.RDNs) > 1 && (&goldap.DN{RDNs: cur.RDNs[1:]}).EqualFold(parsed) {
			return true, nil
		}
	}
	if truncated {
		if len(children) > len(s.ops) {
			return true, nil
		}
		return false, fmt.Errorf("more than %d child entries", len(children))
	}
	return false, nil
}

// loadEntry returns the current (simulated) entry of an existing dn.
func (s *ldifSimulator) loadEntry(dn string) (*models.LDAPEntry, error) {
	key := s.key(dn)
	if st, ok := s.known[key]; ok && st.entry != nil {
		return st.entry, nil
	}
	sdn, gone := s.serverDN(dn)
	if gone {
		return nil, fmt.Errorf("entry does not exist")
	}
	entry, err := s.r.GetEntry(sdn)
	if err != nil {
		return nil, err
	}
	cp := *entry
	cp.DN = dn
	s.known[key] = &ldifSimEntry{exists: true, entry: &cp}
	return &cp, nil
}

// moveKnown re-keys simulated entries at or below oldDN to newDN (rename) or
// marks them as not existing (newDN nil, delete).
func (s *ldifSimulator) moveKnown(oldDN, newDN *goldap.DN) {
	var affected []string
	for key := range s.known {
		parsed, err := goldap.ParseDN(key)
		if err == nil && (oldDN.EqualFold(parsed) || oldDN.AncestorOfFold(parsed)) {
			affected = append(affected, key)
		}
	}
	updates := map[string]*ldifSimEntry{}
	for _, key := range affected {
		st := s.known[key]
		if newDN == nil {
			s.known[key] = &ldifSimEntry{exists: false}
			continue
		}
		parsed, _ := goldap.ParseDN(key)
		moved := replaceDNSuffix(parsed, len(oldDN.RDNs), newDN)
		next := &ldifSimEntry{exists: st.exists}
		if st.entry != nil {
			cp := *st.entry
			cp.DN = moved.String()
			next.entry = &cp
		}
		updates[s.key(moved.String())] = next
		s.known[key] = &ldifSimEntry{exists: false}
	}
	for k, v := range updates {
		s.known[k] = v
	}
}

// bulkParentDN returns the parent DN of dn ("" for a single RDN).
func bulkParentDN(dn string) string {
	_, parent := splitRDN(dn)
	return parent
}

// check validates one record and updates the simulated state.
func (s *ldifSimulator) check(index int, rec *ldif.ChangeRecord) models.LDIFRecordPreview {
	rp, _ := s.plan(index, rec)
	return rp
}

// failedLineAbove returns the line of a failed add record of dn or of an
// entry above it (apply), 0 when there is none.
func (s *ldifSimulator) failedLineAbove(dn string) (int, string) {
	if len(s.failed) == 0 {
		return 0, ""
	}
	parsed, err := goldap.ParseDN(dn)
	if err != nil {
		return 0, ""
	}
	for i := 0; i < len(parsed.RDNs); i++ {
		cur := (&goldap.DN{RDNs: parsed.RDNs[i:]}).String()
		if line, ok := s.failed[s.key(cur)]; ok {
			return line, cur
		}
	}
	return 0, ""
}

// refState answers planLDIFAdd whether a referenced DN exists, or is
// created by a later add record of the file.
func (s *ldifSimulator) refState(dn string) ldifRefState {
	if _, err := goldap.ParseDN(dn); err != nil {
		return ldifRefUnknown
	}
	ok, err := s.entryExists(dn)
	switch {
	case err != nil:
		return ldifRefUnknown
	case ok:
		return ldifRefExists
	}
	if at, later := s.addAt[s.key(dn)]; later && at > s.current {
		return ldifRefLater
	}
	return ldifRefMissing
}

// ldifPrefetchWorkers is the number of reads prefetch runs in parallel on
// the connection (go-ldap multiplexes them).
const ldifPrefetchWorkers = 8

// ldifPrefetchMax caps the reads of one prefetch.
const ldifPrefetchMax = 300000

// prefetch reads in parallel what the sequential planning of records asks
// the server: whether the DNs the records name exist (the records' DNs,
// parents of adds, new superiors and new DNs of renames; on Active
// Directory the DN values of adds) and, on Active Directory, who holds the
// sAMAccountName / userPrincipalName of the adds. The answers are the
// server's state before the run, which is what the planning asks for (it
// tracks the file's own changes itself). progress is called with the
// number of reads done and the total.
func (s *ldifSimulator) prefetch(ctx context.Context, records []ldif.ChangeRecord, progress func(done, total int)) {
	seen := map[string]bool{}
	var dns []string
	addDN := func(dn string) {
		if dn == "" || len(dns) >= ldifPrefetchMax {
			return
		}
		if _, err := goldap.ParseDN(dn); err != nil {
			return
		}
		key := s.key(dn)
		if seen[key] || s.exists[key] {
			return
		}
		seen[key] = true
		dns = append(dns, dn)
	}
	type ownerQuery struct{ base, attr, value string }
	var owners []ownerQuery
	finder, _ := s.r.(valueOwnerReader)
	for i := range records {
		rec := &records[i]
		if rec.Err != nil {
			continue
		}
		addDN(rec.DN)
		switch rec.ChangeType {
		case models.LDIFChangeAdd:
			addDN(bulkParentDN(rec.DN))
			if !s.sc.isAD {
				continue
			}
			for _, a := range rec.Attributes {
				if !a.Binary && s.sc.lookup(a.Name).syntax == syntaxDN {
					for _, v := range a.Values {
						addDN(v)
					}
				}
			}
			if base := s.sc.namingContextOf(rec.DN); finder != nil && base != "" {
				for _, u := range adUniqueAttributes {
					for _, a := range rec.Attributes {
						if strings.EqualFold(a.Name, u.name) && len(a.Values) > 0 && !a.Binary {
							owners = append(owners, ownerQuery{base, u.name, a.Values[0]})
						}
					}
				}
			}
		case models.LDIFChangeModRDN:
			addDN(rec.NewSuperior)
			newParent := rec.NewSuperior
			if newParent == "" {
				newParent = bulkParentDN(rec.DN)
			}
			if newParent != "" {
				addDN(rec.NewRDN + "," + newParent)
			}
		}
	}
	total := len(dns) + len(owners)
	if total == 0 {
		return
	}
	var mu sync.Mutex
	done := 0
	jobs := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < ldifPrefetchWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				if ctx.Err() != nil {
					continue
				}
				if j < len(dns) {
					found, err := s.r.EntryExists(dns[j])
					mu.Lock()
					if err == nil {
						s.exists[s.key(dns[j])] = found
					}
				} else {
					q := owners[j-len(dns)]
					holders, err := finder.DNsWithValue(q.base, q.attr, q.value, 5)
					mu.Lock()
					if err == nil {
						s.owners[strings.ToLower(q.attr)+"|"+strings.ToLower(q.value)] = holders
					}
				}
				done++
				d := done
				mu.Unlock()
				if progress != nil && d%200 == 0 {
					progress(d, total)
				}
			}
		}()
	}
	for j := 0; j < total && ctx.Err() == nil; j++ {
		jobs <- j
	}
	close(jobs)
	wg.Wait()
}

// prepare records where the file adds which entry (refState), before the
// first record is planned.
func (s *ldifSimulator) prepare(records []ldif.ChangeRecord) {
	s.addAt = make(map[string]int, len(records))
	for i := range records {
		if rec := &records[i]; rec.Err == nil && rec.ChangeType == models.LDIFChangeAdd {
			if _, dup := s.addAt[s.key(rec.DN)]; !dup {
				s.addAt[s.key(rec.DN)] = i
			}
		}
	}
}

// plan validates one record, updates the simulated state and returns what
// apply sends for it (the adapted add, an update, a skip, or nothing).
func (s *ldifSimulator) plan(index int, rec *ldif.ChangeRecord) (models.LDIFRecordPreview, ldifWrite) {
	rp := models.LDIFRecordPreview{
		Index: index, Line: rec.Line, DN: rec.DN, ChangeType: rec.ChangeType,
		Errors: []string{}, Warnings: []string{},
	}
	var w ldifWrite
	s.current = index
	if rec.Err != nil {
		rp.Status = models.LDIFRecordInvalid
		rp.Errors = append(rp.Errors, rec.Err.Error())
		w.action = ldifWriteBlocked
		return rp, w
	}
	rp.Summary = summarizeRecord(rec)
	for _, u := range rec.URLs {
		rp.Warnings = append(rp.Warnings, "value loaded from "+u)
	}

	// A record of an entry whose add failed earlier in this run (or below it).
	if line, dn := s.failedLineAbove(rec.DN); line > 0 {
		what := "the entry"
		if !dnEqual(dn, rec.DN) {
			what = "the parent entry " + dn
		}
		rp.Errors = append(rp.Errors, fmt.Sprintf("not sent: %s was not created (the add record at line %d failed)", what, line))
		rp.Status = models.LDIFRecordError
		w.action = ldifWriteBlocked
		if rec.ChangeType == models.LDIFChangeAdd {
			s.failed[s.key(rec.DN)] = rec.Line
		}
		return rp, w
	}

	exists, err := s.entryExists(rec.DN)
	if err != nil {
		rp.Warnings = append(rp.Warnings, "cannot check the entry: "+err.Error())
		exists = rec.ChangeType != models.LDIFChangeAdd // assume the file is right
	}

	switch rec.ChangeType {
	case models.LDIFChangeAdd:
		rp.Attributes = maskAttributes(rec.Attributes)
		if exists {
			s.planExisting(&rp, &w, rec)
			break
		}
		// A naming context (suffix) entry has no parent entry.
		if parent := bulkParentDN(rec.DN); parent != "" && !s.sc.isNamingContext(rec.DN) {
			if ok, err := s.entryExists(parent); err != nil {
				rp.Warnings = append(rp.Warnings, "cannot check the parent entry: "+err.Error())
			} else if !ok {
				if len(s.sc.namingContexts) > 0 && !s.sc.belowNamingContext(rec.DN) {
					rp.Warnings = append(rp.Warnings, "parent entry "+parent+" does not exist and "+rec.DN+
						" is not below a naming context of the server; the add only works if it is a suffix of the server")
				} else {
					rp.Errors = append(rp.Errors, "parent entry "+parent+" does not exist")
				}
			}
		}
		p := planLDIFAdd(rec.Attributes, s.set, s.sc, false, s.refState)
		rp.Errors = append(rp.Errors, p.errors...)
		rp.Adjustments = p.adjustments
		w.attrs, w.controls, w.deferred = p.attrs, ldifRelaxControls(p.relax), p.deferred
		if ldifUnicodePwdBlocked(p.errors) {
			w.action = ldifWriteBlocked
		}
		if s.sc.isAD {
			s.checkUniqueValues(&rp, &ldif.ChangeRecord{DN: rec.DN, Attributes: p.attrs})
		}
		key := s.key(rec.DN)
		w.undo = func() {
			s.known[key] = &ldifSimEntry{exists: false}
			s.failed[key] = rec.Line
		}
		if len(rp.Errors) == 0 {
			s.known[key] = &ldifSimEntry{exists: true, entry: &models.LDAPEntry{DN: rec.DN, Attributes: p.attrs}}
		}

	case models.LDIFChangeDelete:
		if !exists {
			rp.Errors = append(rp.Errors, "entry does not exist")
			break
		}
		if children, err := s.hasChildren(rec.DN); err != nil {
			rp.Warnings = append(rp.Warnings, "cannot check whether the entry has child entries: "+err.Error())
		} else if children {
			// not applied to the simulation: the children stay
			rp.Errors = append(rp.Errors, "entry has child entries; LDAP delete only removes leaf entries (notAllowedOnNonLeaf), delete the children first")
			break
		}
		if parsed, err := goldap.ParseDN(rec.DN); err == nil {
			w.undo = s.snapshot(parsed)
			s.moveKnown(parsed, nil)
			s.ops = append(s.ops, ldifSubtreeOp{oldDN: parsed})
		}
		s.known[s.key(rec.DN)] = &ldifSimEntry{exists: false}

	case models.LDIFChangeModify:
		rp.Changes = maskChanges(rec.Changes)
		if !exists {
			rp.Errors = append(rp.Errors, "entry does not exist")
			break
		}
		entry, err := s.loadEntry(rec.DN)
		if err != nil {
			rp.Warnings = append(rp.Warnings, "cannot read the entry: "+err.Error())
			break
		}
		sim := simulateChanges(entry, rec.Changes, simulateMode{}, s.sc)
		rp.Errors = append(rp.Errors, sim.errors...)
		rp.Warnings = append(rp.Warnings, sim.warnings...)
		rp.Diffs = sim.diffs
		key := s.key(rec.DN)
		w.undo = func() { s.known[key] = &ldifSimEntry{exists: true} } // read again
		if len(sim.errors) == 0 {
			s.known[key] = &ldifSimEntry{exists: true, entry: sim.after}
		}

	case models.LDIFChangeModRDN:
		rp.NewRDN, rp.DeleteOldRDN, rp.NewSuperior = rec.NewRDN, rec.DeleteOldRDN, rec.NewSuperior
		newParent := rec.NewSuperior
		if newParent == "" {
			newParent = bulkParentDN(rec.DN)
		}
		newDN := rec.NewRDN
		if newParent != "" {
			newDN += "," + newParent
		}
		rp.NewDN = newDN
		if !exists {
			rp.Errors = append(rp.Errors, "entry does not exist")
			break
		}
		if !rec.DeleteOldRDN {
			if s.sc.isAD {
				rp.Errors = append(rp.Errors, "Active Directory requires \"deleteoldrdn: 1\" (the old RDN value cannot be kept)")
			} else if msg := keptRDNConflict(rec.DN, rec.NewRDN, s.sc); msg != "" {
				rp.Errors = append(rp.Errors, msg)
			}
		}
		if rec.NewSuperior != "" {
			if ok, err := s.entryExists(rec.NewSuperior); err != nil {
				rp.Warnings = append(rp.Warnings, "cannot check the new superior: "+err.Error())
			} else if !ok {
				rp.Errors = append(rp.Errors, "new superior "+rec.NewSuperior+" does not exist")
			}
		}
		if !dnEqual(newDN, rec.DN) {
			if ok, err := s.entryExists(newDN); err != nil {
				rp.Warnings = append(rp.Warnings, "cannot check the new DN: "+err.Error())
			} else if ok {
				rp.Errors = append(rp.Errors, "an entry "+newDN+" already exists")
			}
		}
		if len(rp.Errors) > 0 {
			break
		}
		entry, err := s.loadEntry(rec.DN)
		if err != nil {
			rp.Warnings = append(rp.Warnings, "cannot read the entry: "+err.Error())
			entry = nil
		}
		oldParsed, err1 := goldap.ParseDN(rec.DN)
		newParsed, err2 := goldap.ParseDN(newDN)
		if err1 == nil && err2 == nil {
			undoOld, undoNew := s.snapshot(oldParsed), s.snapshot(newParsed)
			w.undo = func() { undoNew(); undoOld() }
		}
		s.applyRename(rec, newDN, entry)
	}

	if s.passwords != nil && len(rp.Errors) == 0 {
		switch w.action {
		case ldifWriteSkip, ldifWriteUnchanged, ldifWriteBlocked:
		case ldifWriteUpdate:
			s.passwords.annotateChanges(&rp, w.changes)
		default:
			if rec.ChangeType == models.LDIFChangeAdd {
				s.passwords.annotateAttributes(&rp, w.attrs)
			} else {
				s.passwords.annotate(&rp, rec)
			}
		}
	}

	switch {
	case len(rp.Errors) > 0:
		rp.Status = models.LDIFRecordError
	case w.action == ldifWriteSkip || w.action == ldifWriteUnchanged:
		rp.Status = models.LDIFRecordSkip
	case len(rp.Warnings) > 0:
		rp.Status = models.LDIFRecordWarning
	default:
		rp.Status = models.LDIFRecordOK
	}
	return rp, w
}

// planExisting plans an add record whose entry exists already, following
// the "existing" import option: an error, a skip, or an update that gives
// the entry the record's attributes.
func (s *ldifSimulator) planExisting(rp *models.LDIFRecordPreview, w *ldifWrite, rec *ldif.ChangeRecord) {
	existing := func(reason, text string) {
		rp.Adjustments = append(rp.Adjustments, models.LDIFAdjustment{Kind: models.LDIFAdjustExisting, Attributes: []string{}, Reason: reason, Text: text})
	}
	switch s.set.opts.Existing {
	case models.LDIFExistingFail:
		rp.Errors = append(rp.Errors, "entry already exists (choose Skip or Update under Entries that already exist)")
		w.action = ldifWriteBlocked
		return
	case models.LDIFExistingSkip:
		w.action = ldifWriteSkip
		existing("The entry exists already: skipped", "The entry exists already: skipped")
		return
	}
	entry, err := s.loadEntry(rec.DN)
	if err != nil {
		rp.Errors = append(rp.Errors, "the entry exists already but cannot be read for the update: "+err.Error())
		return
	}
	p := planLDIFAdd(rec.Attributes, s.set, s.sc, true, s.refState)
	rp.Errors = append(rp.Errors, p.errors...)
	w.deferred = p.deferred
	changes := ldifUpdateChanges(entry, p.attrs, s.sc)
	sim := simulateChanges(entry, changes, simulateMode{dropNoOps: true}, s.sc)
	rp.Errors = append(rp.Errors, sim.errors...)
	rp.Warnings = append(rp.Warnings, sim.warnings...)
	rp.Diffs = sim.diffs
	rp.Adjustments = p.adjustments
	if ldifUnicodePwdBlocked(p.errors) {
		w.action = ldifWriteBlocked
		return
	}
	if len(sim.changes) == 0 {
		w.action = ldifWriteUnchanged
		existing("The entry exists already with these values: nothing to change", "The entry exists already with these values: nothing to change")
		return
	}
	w.action = ldifWriteUpdate
	w.changes = sim.changes
	w.entry = entry
	rp.Changes = maskChanges(sim.changes)
	rp.Summary = "update the existing entry: " + summarizeRecord(&ldif.ChangeRecord{ChangeType: models.LDIFChangeModify, Changes: sim.changes})
	existing("The entry exists already: updated with the record's attributes",
		fmt.Sprintf("The entry exists already: updated with the record's attributes (%d change%s)", len(sim.changes), plural(len(sim.changes))))
	key := s.key(rec.DN)
	w.undo = func() { s.known[key] = &ldifSimEntry{exists: true} }
	if len(rp.Errors) == 0 {
		s.known[key] = &ldifSimEntry{exists: true, entry: sim.after}
	}
}

// snapshot records the simulated state at and below dn and the number of
// subtree operations; the returned function restores them (a delete or
// rename whose write failed).
func (s *ldifSimulator) snapshot(dn *goldap.DN) func() {
	saved := map[string]*ldifSimEntry{}
	for key, st := range s.known {
		if parsed, err := goldap.ParseDN(key); err == nil && (dn.EqualFold(parsed) || dn.AncestorOfFold(parsed)) {
			saved[key] = st
		}
	}
	nops := len(s.ops)
	return func() {
		for key := range s.known {
			if _, ok := saved[key]; ok {
				continue
			}
			if parsed, err := goldap.ParseDN(key); err == nil && (dn.EqualFold(parsed) || dn.AncestorOfFold(parsed)) {
				delete(s.known, key)
			}
		}
		for key, st := range saved {
			s.known[key] = st
		}
		if len(s.ops) > nops {
			s.ops = s.ops[:nops]
		}
	}
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// checkUniqueValues predicts AD's unique-value checks for an add record:
// a sAMAccountName (error) or userPrincipalName (warning) already held by an
// entry of the domain (an export re-imported next to the original), or by an
// earlier add record of the file. Entries the file deleted before do not
// count.
func (s *ldifSimulator) checkUniqueValues(rp *models.LDIFRecordPreview, rec *ldif.ChangeRecord) {
	finder, _ := s.r.(valueOwnerReader)
	base := s.sc.namingContextOf(rec.DN)
	for _, u := range adUniqueAttributes {
		var value string
		for _, a := range rec.Attributes {
			if strings.EqualFold(a.Name, u.name) && len(a.Values) > 0 && !a.Binary {
				value = a.Values[0]
			}
		}
		if value == "" {
			continue
		}
		report := func(owner string) {
			msg := fmt.Sprintf("%s '%s' is already used by %s (AD keeps it unique)", u.name, value, owner)
			if u.error {
				rp.Errors = append(rp.Errors, msg)
			} else {
				rp.Warnings = append(rp.Warnings, msg)
			}
		}
		key := strings.ToLower(u.name) + "|" + strings.ToLower(value)
		if owner, ok := s.unique[key]; ok && !dnEqual(owner, rec.DN) {
			report(owner + " (an earlier record of this file)")
			continue
		}
		s.unique[key] = rec.DN
		if finder == nil || base == "" {
			continue
		}
		owners, cached := s.owners[key]
		var err error
		if !cached {
			owners, err = finder.DNsWithValue(base, u.name, value, 5)
		}
		if err != nil {
			rp.Warnings = append(rp.Warnings, "cannot check whether "+u.name+" is in use: "+err.Error())
			continue
		}
		for _, owner := range owners {
			if st, ok := s.known[s.key(owner)]; ok && !st.exists {
				continue // deleted by an earlier record
			}
			if !dnEqual(owner, rec.DN) {
				report(owner)
				break
			}
		}
	}
}

// keptRDNConflict predicts the failure of a modrdn with "deleteoldrdn: 0"
// whose naming attribute is single-valued: keeping the old value next to a
// different new value would give it two values. Returns "" when no conflict
// is known.
func keptRDNConflict(dn, newRDN string, sc *schemaContext) string {
	oldDN, err1 := goldap.ParseDN(dn)
	newDN, err2 := goldap.ParseDN(newRDN)
	if err1 != nil || err2 != nil || len(oldDN.RDNs) == 0 || len(newDN.RDNs) == 0 {
		return ""
	}
	for _, nava := range newDN.RDNs[0].Attributes {
		info := sc.lookup(nava.Type)
		if !info.found || !info.singleValue {
			continue
		}
		for _, oava := range oldDN.RDNs[0].Attributes {
			if strings.EqualFold(oava.Type, nava.Type) && !strings.EqualFold(oava.Value, nava.Value) {
				return fmt.Sprintf("%s is single-valued: \"deleteoldrdn: 0\" would keep %q next to %q; use \"deleteoldrdn: 1\"", info.name, oava.Value, nava.Value)
			}
		}
	}
	return ""
}

// applyRename updates the simulated state after a modrdn record: the entry
// and everything below it move to newDN, the naming attribute values follow
// newrdn / deleteoldrdn.
func (s *ldifSimulator) applyRename(rec *ldif.ChangeRecord, newDN string, entry *models.LDAPEntry) {
	oldParsed, err1 := goldap.ParseDN(rec.DN)
	newParsed, err2 := goldap.ParseDN(newDN)
	if err1 != nil || err2 != nil {
		return
	}
	var renamed *models.LDAPEntry
	if entry != nil {
		renamed = &models.LDAPEntry{DN: newDN, Attributes: renameAttributes(entry.Attributes, oldParsed, newParsed, rec.DeleteOldRDN)}
	}
	s.moveKnown(oldParsed, newParsed)
	s.ops = append(s.ops, ldifSubtreeOp{rename: true, oldDN: oldParsed, newDN: newParsed})
	s.known[s.key(rec.DN)] = &ldifSimEntry{exists: false}
	s.known[s.key(newDN)] = &ldifSimEntry{exists: true, entry: renamed}
}

// renameAttributes applies the naming value changes of a modrdn.
func renameAttributes(attrs []models.LDAPAttribute, oldDN, newDN *goldap.DN, deleteOld bool) []models.LDAPAttribute {
	out := make([]models.LDAPAttribute, 0, len(attrs)+1)
	for _, a := range attrs {
		out = append(out, models.LDAPAttribute{Name: a.Name, Values: append([]string(nil), a.Values...), Binary: a.Binary})
	}
	find := func(name string) int {
		for i, a := range out {
			if strings.EqualFold(a.Name, name) {
				return i
			}
		}
		return -1
	}
	if deleteOld && len(oldDN.RDNs) > 0 {
		for _, ava := range oldDN.RDNs[0].Attributes {
			if i := find(ava.Type); i >= 0 {
				kept := out[i].Values[:0]
				for _, v := range out[i].Values {
					if !strings.EqualFold(v, ava.Value) {
						kept = append(kept, v)
					}
				}
				out[i].Values = kept
			}
		}
	}
	if len(newDN.RDNs) > 0 {
		for _, ava := range newDN.RDNs[0].Attributes {
			i := find(ava.Type)
			if i < 0 {
				out = append(out, models.LDAPAttribute{Name: ava.Type, Values: []string{ava.Value}})
				continue
			}
			present := false
			for _, v := range out[i].Values {
				if strings.EqualFold(v, ava.Value) {
					present = true
				}
			}
			if !present {
				out[i].Values = append(out[i].Values, ava.Value)
			}
		}
	}
	kept := out[:0]
	for _, a := range out {
		if len(a.Values) > 0 {
			kept = append(kept, a)
		}
	}
	return kept
}

// summarizeRecord describes a record in one line.
func summarizeRecord(rec *ldif.ChangeRecord) string {
	switch rec.ChangeType {
	case models.LDIFChangeAdd:
		var ocs []string
		for _, a := range rec.Attributes {
			if strings.EqualFold(a.Name, "objectClass") {
				ocs = a.Values
			}
		}
		s := fmt.Sprintf("add entry with %d attribute(s)", len(rec.Attributes))
		if len(ocs) > 0 {
			s += " (" + strings.Join(ocs, ", ") + ")"
		}
		return s
	case models.LDIFChangeDelete:
		return "delete entry"
	case models.LDIFChangeModify:
		parts := make([]string, 0, len(rec.Changes))
		for _, ch := range rec.Changes {
			p := ch.Operation + " " + ch.Attribute
			if n := len(ch.Values); n > 1 {
				p += fmt.Sprintf(" (%d values)", n)
			} else if n == 0 && ch.Operation != models.ChangeAdd {
				p += " (all values)"
			}
			parts = append(parts, p)
		}
		return strings.Join(parts, "; ")
	case models.LDIFChangeModRDN:
		s := "rename to " + rec.NewRDN
		if rec.NewSuperior != "" {
			s += " under " + rec.NewSuperior
		}
		if rec.DeleteOldRDN {
			s += " (delete old RDN)"
		} else {
			s += " (keep old RDN)"
		}
		return s
	}
	return ""
}

// maskAttributes masks password values and summarizes binary values.
func maskAttributes(attrs []models.LDAPAttribute) []models.LDAPAttribute {
	out := make([]models.LDAPAttribute, len(attrs))
	for i, a := range attrs {
		out[i] = models.LDAPAttribute{Name: a.Name, Values: displayValues(a.Name, a.Values, a.Binary, 0)}
	}
	return out
}

// ApplyLDIFChanges applies an LDIF file with content and change records in
// file order: add (AddEntry), modify (one atomic ModifyEntry per record, as
// written), delete and modrdn/moddn (RenameEntry). userPassword values
// follow the connection's password storage policy unless
// options.Passwords.AsIs keeps them exactly as in the file; "ask" and
// unencrypted connections need options.Passwords decisions. Files with syntax errors
// are refused, as are read-only connections (ldap.ErrReadOnly). With
// options.ContinueOnError false the run stops at the first failed record;
// StopBulkRun(options.RunID) stops it as well, the rest is reported as
// notProcessed. Every write is audited (CREATE, MODIFY, DELETE, RENAME).
// Progress is sent as "bulk:progress" events with phase "apply".
func (s *ExportService) ApplyLDIFChanges(profileID string, content string, options models.BulkOptions) (*models.BulkApplyResult, error) {
	if content == "" && options.PreviewRunID != "" {
		kept, ok := keptLDIFContent(options.PreviewRunID)
		if !ok {
			return nil, fmt.Errorf("the dry run is no longer available; run it again")
		}
		content = kept
	}
	parsed := parseLDIFChanges(content)
	if n := len(parsed.Errors); n > 0 {
		return nil, fmt.Errorf("the LDIF has %d syntax error(s), nothing was applied; first: %v", n, parsed.Errors[0])
	}
	if len(parsed.Records) == 0 {
		return nil, fmt.Errorf("the LDIF contains no records")
	}
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	if err := client.CheckWritable(); err != nil {
		return nil, err
	}
	set, err := newLDIFImportSettings(client, options.Import)
	if err != nil {
		return nil, err
	}
	// Every record is planned again against the current directory, exactly
	// like in the dry run, so the adaptations match it.
	sim := newLDIFSimulator(client, loadSchemaContext(client, profileID), set)
	sim.prepare(parsed.Records)
	var deferred []ldifDeferredWrite

	ctx, done := bulkRuns.start(options.RunID)
	defer done()
	progress := newProgressEmitter(s.ctx, options.RunID, "apply", len(parsed.Records))

	res := &models.BulkApplyResult{RunID: options.RunID, Total: len(parsed.Records), Items: make([]models.BulkResultItem, 0, len(parsed.Records))}
	tag := ldifRunTag(options.RunID)
	sim.prefetch(ctx, parsed.Records, func(done, total int) {
		progress.emit(0, fmt.Sprintf("checking the directory: %d of %d reads", done, total), 0, 0, 0)
	})

	// Add records run concurrently (up to ldifApplyWindow requests on the
	// connection): each waits for the records of its entry and its parents
	// that are still running, deletes and renames wait for all of them. Runs
	// that stop at the first failure and Active Directory (unique values and
	// references between the file's entries) run one record at a time.
	window := 1
	if options.ContinueOnError && set.serverType != models.ServerTypeAD {
		window = ldifApplyWindow
	}
	run := newLDIFApplyRun(len(parsed.Records), window)
	for i := range parsed.Records {
		rec := &parsed.Records[i]
		if ctx.Err() != nil || run.stopped() {
			break
		}
		if window == 1 || rec.ChangeType == models.LDIFChangeDelete || rec.ChangeType == models.LDIFChangeModRDN {
			run.waitAll()
		} else {
			run.waitFor(rec.DN)
		}
		start := time.Now()
		run.mu.Lock()
		rp, w := sim.plan(i, rec)
		run.mu.Unlock()
		finish := func(item models.BulkResultItem, opErr error) {
			run.mu.Lock()
			defer run.mu.Unlock()
			if w.action == ldifWriteSend || w.action == ldifWriteUpdate {
				switch {
				case opErr != nil && w.undo != nil:
					w.undo()
				case opErr == nil && len(rp.Errors) > 0:
					sim.written(rec, w) // predicted to fail, but the server took it
				}
				if opErr == nil && len(w.deferred) > 0 {
					deferred = append(deferred, ldifDeferredWrite{rec: rec, changes: w.deferred})
				}
			}
			if w.action != ldifWriteSkip && w.action != ldifWriteUnchanged { // their message says it
				item.Adjusted = ldifAdjustedSummary(rp.Adjustments)
			}
			item.DurationMs = time.Since(start).Milliseconds()
			run.done(i, item)
			progress.emit(run.count, rec.DN, run.succeeded, run.failed, run.skipped)
			if stop, reason := shouldStop(item, opErr, options); stop {
				run.stop(reason)
			}
		}
		switch w.action {
		case ldifWriteSkip, ldifWriteUnchanged:
			item := models.BulkResultItem{Line: rec.Line, DN: rec.DN, Operation: rec.ChangeType, Status: models.BulkResultSkipped, Message: ldifExistingText(rp.Adjustments)}
			if w.action == ldifWriteUnchanged {
				item.Status = models.BulkResultUnchanged
			}
			finish(item, nil)
		case ldifWriteBlocked:
			run.mu.Lock()
			if w.undo != nil {
				w.undo()
			}
			run.mu.Unlock()
			finish(models.BulkResultItem{Line: rec.Line, DN: rec.DN, Operation: rec.ChangeType, Status: models.BulkResultFailed, Message: strings.Join(rp.Errors, "; ")}, nil)
		default:
			if window == 1 || rec.ChangeType != models.LDIFChangeAdd || w.action != ldifWriteSend || len(w.deferred) > 0 {
				run.waitAll()
				finish(s.applyRecord(client, profileID, rec, w, options.Passwords, tag))
				continue
			}
			run.dispatch(rec.DN, func() { finish(s.applyRecord(client, profileID, rec, w, options.Passwords, tag)) })
		}
	}
	run.waitAll()
	for i := range parsed.Records {
		if item, ok := run.item(i); ok {
			addResultItem(res, item)
			continue
		}
		rec := &parsed.Records[i]
		reason := run.reason
		if reason == "" {
			reason = "stopped by user"
		}
		res.Stopped = true
		if res.StopReason == "" {
			res.StopReason = reason
		}
		addResultItem(res, models.BulkResultItem{Line: rec.Line, DN: rec.DN, Operation: rec.ChangeType, Status: models.BulkResultNotProcessed, Message: reason})
	}
	if run.reason != "" {
		res.Stopped, res.StopReason = true, run.reason
	}
	sort.SliceStable(deferred, func(a, b int) bool { return deferred[a].rec.Line < deferred[b].rec.Line })
	s.applyDeferred(ctx, client, profileID, sim, deferred, tag, res)
	return res, nil
}

// ldifExistingText is the text of the "existing entry" adjustment.
func ldifExistingText(adjs []models.LDIFAdjustment) string {
	for _, a := range adjs {
		if a.Kind == models.LDIFAdjustExisting {
			return a.Text
		}
	}
	return ""
}

// ldifApplyWindow is the number of add requests an LDIF apply keeps
// running on the connection at the same time.
const ldifApplyWindow = 8

// ldifApplyRun schedules the writes of an apply: the results by record,
// the counters for progress events, the stop reason, and the add records
// still running (by DN) that later records of the same entry or below it
// wait for.
type ldifApplyRun struct {
	mu       sync.Mutex // also guards the simulator while writes run
	items    []models.BulkResultItem
	has      []bool
	count    int
	reason   string
	inflight map[string]chan struct{}
	sem      chan struct{}
	wg       sync.WaitGroup

	succeeded, failed, skipped int
}

func newLDIFApplyRun(n, window int) *ldifApplyRun {
	return &ldifApplyRun{items: make([]models.BulkResultItem, n), has: make([]bool, n), inflight: map[string]chan struct{}{}, sem: make(chan struct{}, window)}
}

// done records the result of record i (mu held).
func (r *ldifApplyRun) done(i int, item models.BulkResultItem) {
	r.items[i], r.has[i] = item, true
	r.count++
	switch item.Status {
	case models.BulkResultSuccess:
		r.succeeded++
	case models.BulkResultFailed:
		r.failed++
	default:
		r.skipped++
	}
}

func (r *ldifApplyRun) item(i int) (models.BulkResultItem, bool) {
	return r.items[i], r.has[i]
}

// stop ends the run after the running writes (mu held).
func (r *ldifApplyRun) stop(reason string) {
	if r.reason == "" {
		r.reason = reason
	}
}

func (r *ldifApplyRun) stopped() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.reason != ""
}

// dispatch runs write in the background once a slot is free; records of
// dn or below it wait for it (waitFor).
func (r *ldifApplyRun) dispatch(dn string, write func()) {
	key := bulkDNKey(dn)
	ch := make(chan struct{})
	r.mu.Lock()
	r.inflight[key] = ch
	r.mu.Unlock()
	r.sem <- struct{}{}
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		write()
		r.mu.Lock()
		if r.inflight[key] == ch {
			delete(r.inflight, key)
		}
		r.mu.Unlock()
		close(ch)
		<-r.sem
	}()
}

// waitFor waits until no write of dn or of an entry above it is running.
func (r *ldifApplyRun) waitFor(dn string) {
	parsed, err := goldap.ParseDN(dn)
	if err != nil {
		r.waitAll()
		return
	}
	for i := 0; i < len(parsed.RDNs); i++ {
		key := strings.ToLower((&goldap.DN{RDNs: parsed.RDNs[i:]}).String())
		r.mu.Lock()
		ch := r.inflight[key]
		r.mu.Unlock()
		if ch != nil {
			<-ch
		}
	}
}

// waitAll waits for every running write.
func (r *ldifApplyRun) waitAll() {
	r.wg.Wait()
}

// ldifDeferredWrite are the value adds of a created entry that wait for the
// entries they refer to.
type ldifDeferredWrite struct {
	rec     *ldif.ChangeRecord
	changes []models.AttributeChange
}

// applyDeferred adds the deferred DN values at the end of the run, one
// modify per entry, leaving out values of entries that were not created.
// Each write is a result item of its own (operation modify).
func (s *ExportService) applyDeferred(ctx context.Context, client *ldap.Client, profileID string, sim *ldifSimulator, deferred []ldifDeferredWrite, tag string, res *models.BulkApplyResult) {
	for _, d := range deferred {
		res.Total++
		item := models.BulkResultItem{Line: d.rec.Line, DN: d.rec.DN, Operation: models.LDIFChangeModify}
		if ctx.Err() != nil {
			item.Status, item.Message = models.BulkResultNotProcessed, "stopped by user: the references were not added"
			addResultItem(res, item)
			continue
		}
		start := time.Now()
		var changes []models.AttributeChange
		var dropped []string
		for _, ch := range d.changes {
			kept := ch
			kept.Values = nil
			for _, v := range ch.Values {
				if ok, err := sim.entryExists(v); err == nil && !ok {
					dropped = append(dropped, v)
					continue
				}
				kept.Values = append(kept.Values, v)
			}
			if len(kept.Values) > 0 {
				changes = append(changes, kept)
			}
		}
		item.Details = "references added at the end of the run: " + describeChangesForAudit(changes)
		switch {
		case len(changes) == 0:
			item.Status, item.Message = models.BulkResultSkipped, "the referenced entries were not created: "+strings.Join(dropped, "; ")
		default:
			err := client.ModifyEntry(d.rec.DN, changes)
			writeAudit(s.auditStore, s.pool, profileID, "MODIFY", d.rec.DN, ldifAuditDetails("modify", tag, ": "+describeChangesForAudit(changes)), err)
			if err != nil {
				item.Status, item.Message = models.BulkResultFailed, err.Error()
			} else {
				item.Status = models.BulkResultSuccess
				if len(dropped) > 0 {
					item.Message = "not added (entries not created): " + strings.Join(dropped, "; ")
				}
			}
		}
		item.DurationMs = time.Since(start).Milliseconds()
		addResultItem(res, item)
	}
}

// written updates the simulated state after a write the dry run predicted
// to fail but the server accepted.
func (s *ldifSimulator) written(rec *ldif.ChangeRecord, w ldifWrite) {
	key := s.key(rec.DN)
	switch rec.ChangeType {
	case models.LDIFChangeAdd:
		if w.action == ldifWriteUpdate {
			s.known[key] = &ldifSimEntry{exists: true}
			return
		}
		s.known[key] = &ldifSimEntry{exists: true, entry: &models.LDAPEntry{DN: rec.DN, Attributes: w.attrs}}
	case models.LDIFChangeModify:
		s.known[key] = &ldifSimEntry{exists: true}
	case models.LDIFChangeDelete:
		if parsed, err := goldap.ParseDN(rec.DN); err == nil {
			s.moveKnown(parsed, nil)
			s.ops = append(s.ops, ldifSubtreeOp{oldDN: parsed})
		}
		s.known[key] = &ldifSimEntry{exists: false}
	case models.LDIFChangeModRDN:
		newParent := rec.NewSuperior
		if newParent == "" {
			newParent = bulkParentDN(rec.DN)
		}
		newDN := rec.NewRDN
		if newParent != "" {
			newDN += "," + newParent
		}
		s.applyRename(rec, newDN, nil)
	}
}

// applyRecord writes one record as planned by the simulator (w: the
// adapted add, or the update of an existing entry) and audits it with the
// run's tag (ldifAuditDetails). userPassword values of add and modify
// records follow the password storage policy with pw (pw.AsIs: "store
// passwords exactly as in the file").
func (s *ExportService) applyRecord(client *ldap.Client, profileID string, rec *ldif.ChangeRecord, w ldifWrite, pw models.PasswordWriteOptions, tag string) (models.BulkResultItem, error) {
	item := models.BulkResultItem{Line: rec.Line, DN: rec.DN, Operation: rec.ChangeType}
	var err error
	var report *models.PasswordWriteReport
	switch {
	case w.action == ldifWriteUpdate:
		// An add record of an existing entry, sent as a modify of it.
		item.Operation = models.LDIFChangeModify
		item.Details = "update of the existing entry: " + describeChangesForAudit(w.changes)
		guard := client.GuardPermanentLock(rec.DN, w.changes)
		report, err = client.ModifyEntryWithPasswordPolicy(rec.DN, w.changes, pw)
		item.Details += describePasswordReport(report)
		writeAudit(s.auditStore, s.pool, profileID, "MODIFY", rec.DN, ldifAuditDetails("modify", tag, ": "+describeChangesWithBefore(w.changes, auditBeforeFromEntry(w.entry, w.changes))+describePasswordReport(report)), err)
		if err == nil {
			err = keepDisabledAfterBulk(&item, passwordReportMessages(report), guard, func(op, dn, details string, err error) {
				writeAudit(s.auditStore, s.pool, profileID, op, dn, details, err)
			})
			item.PasswordWarning = passwordReportWarning(report)
			return item, err
		}
	case rec.ChangeType == models.LDIFChangeAdd:
		item.Details = describeAttributesForAudit(w.attrs)
		report, err = client.AddEntryWithPasswordPolicy(rec.DN, w.attrs, pw, w.controls...)
		item.Details += describePasswordReport(report)
		writeAudit(s.auditStore, s.pool, profileID, "CREATE", rec.DN, ldifAuditDetails("import", tag, ", "+item.Details), err)
	case rec.ChangeType == models.LDIFChangeModify:
		item.Details = describeChangesForAudit(rec.Changes)
		guard := client.GuardPermanentLock(rec.DN, rec.Changes)
		before := auditBefore(client, rec.DN, rec.Changes)
		report, err = client.ModifyEntryWithPasswordPolicy(rec.DN, rec.Changes, pw)
		item.Details += describePasswordReport(report)
		writeAudit(s.auditStore, s.pool, profileID, "MODIFY", rec.DN, ldifAuditDetails("modify", tag, ": "+describeChangesWithBefore(rec.Changes, before)+describePasswordReport(report)), err)
		if err == nil {
			err = keepDisabledAfterBulk(&item, passwordReportMessages(report), guard, func(op, dn, details string, err error) {
				writeAudit(s.auditStore, s.pool, profileID, op, dn, details, err)
			})
			item.PasswordWarning = passwordReportWarning(report)
			return item, err
		}
	case rec.ChangeType == models.LDIFChangeDelete:
		item.Details = "delete entry"
		err = client.DeleteEntry(rec.DN)
		writeAudit(s.auditStore, s.pool, profileID, "DELETE", rec.DN, ldifAuditDetails("delete", tag, ""), err)
	case rec.ChangeType == models.LDIFChangeModRDN:
		newParent := rec.NewSuperior
		if newParent == "" {
			newParent = bulkParentDN(rec.DN)
		}
		item.NewDN = rec.NewRDN
		if newParent != "" {
			item.NewDN += "," + newParent
		}
		item.Details = fmt.Sprintf("newRDN=%s deleteOldRDN=%t newSuperior=%s", rec.NewRDN, rec.DeleteOldRDN, rec.NewSuperior)
		err = client.RenameEntry(rec.DN, rec.NewRDN, rec.DeleteOldRDN, rec.NewSuperior)
		writeAudit(s.auditStore, s.pool, profileID, renameAuditOperation(rec.DN, rec.NewSuperior), rec.DN,
			ldifAuditDetails("modrdn", tag, ": "+describeRenameForAudit(rec.DN, rec.NewRDN, rec.DeleteOldRDN, rec.NewSuperior)), err)
	default:
		err = fmt.Errorf("unsupported change type %q", rec.ChangeType)
	}
	if err != nil {
		item.Status = models.BulkResultFailed
		item.Message = err.Error()
	} else {
		item.Status = models.BulkResultSuccess
		item.Message = strings.Join(passwordReportMessages(report), "; ")
		item.PasswordWarning = passwordReportWarning(report)
	}
	return item, err
}

// ldifRunTag is the short marker of one LDIF apply run in its audit
// details: 8 hex digits of an FNV-1a hash of the run ID (the frontend's
// random UUID), random without one. The Import / Export panel groups its
// recent LDIF changes by it (DEF-18).
func ldifRunTag(runID string) string {
	if runID == "" {
		var b [4]byte
		if _, err := rand.Read(b[:]); err == nil {
			return hex.EncodeToString(b[:])
		}
		runID = time.Now().String()
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(runID))
	return fmt.Sprintf("%08x", h.Sum32())
}

// ldifAuditDetails is the audit detail text of an applied LDIF record:
// "LDIF <kind> [run <tag>]" + rest, e.g. "LDIF import [run 1a2b3c4d], cn=…",
// "LDIF modify [run 1a2b3c4d]: description: …", "LDIF delete [run …]",
// "LDIF modrdn [run …]: newRDN=… newDN=…". It always starts with "LDIF "
// (the panel's filter) and ends like before (opTone reads newDN= at the end).
func ldifAuditDetails(kind, tag, rest string) string {
	head := "LDIF " + kind
	if tag != "" {
		head += " [run " + tag + "]"
	}
	return head + rest
}

// ldifPasswordPlanning annotates LDIF preview records with what the
// password storage policy does with their userPassword values.
type ldifPasswordPlanning struct {
	policy models.EffectivePasswordPolicy
	opts   models.PasswordWriteOptions
	// merged is the plan of every record together (LDIFPreview.Passwords).
	merged *models.PasswordWritePlan
}

// annotate adds the plan of rec's password values to rp (modify records;
// add records are planned with their adapted attributes, see
// annotateAttributes).
func (p *ldifPasswordPlanning) annotate(rp *models.LDIFRecordPreview, rec *ldif.ChangeRecord) {
	switch rec.ChangeType {
	case models.LDIFChangeAdd:
		p.annotateAttributes(rp, rec.Attributes)
	case models.LDIFChangeModify:
		p.annotateChanges(rp, rec.Changes)
	}
}

// annotateAttributes adds the plan of the password values of an add.
func (p *ldifPasswordPlanning) annotateAttributes(rp *models.LDIFRecordPreview, attrs []models.LDAPAttribute) {
	plan, err := ldap.PlanPasswordAttributes(p.policy, attrs, p.opts)
	p.addPlan(rp, plan, err)
}

// annotateChanges adds the plan of the password values of a modify.
func (p *ldifPasswordPlanning) annotateChanges(rp *models.LDIFRecordPreview, changes []models.AttributeChange) {
	plan, err := ldap.PlanPasswordChanges(p.policy, changes, p.opts)
	p.addPlan(rp, plan, err)
}

// addPlan adds a password plan to rp: actions as notes, warnings (cleartext
// kept, confirmation needed) as warnings.
func (p *ldifPasswordPlanning) addPlan(rp *models.LDIFRecordPreview, plan models.PasswordWritePlan, err error) {
	if err != nil {
		rp.Errors = append(rp.Errors, err.Error())
		return
	}
	notes, warnings := passwordPlanMessages(plan)
	rp.Notes = append(rp.Notes, notes...)
	rp.Warnings = append(rp.Warnings, warnings...)
	if plan.HasPasswords {
		if p.merged == nil {
			m := plan
			p.merged = &m
		} else {
			policy := p.merged.Policy
			*p.merged = ldap.MergePasswordPlans(*p.merged, plan)
			p.merged.Policy = policy
		}
	}
}

// ldifHasPasswords reports whether add or modify records carry userPassword
// or unicodePwd values.
func ldifHasPasswords(parsed *ldif.ParseResult) bool {
	for i := range parsed.Records {
		rec := &parsed.Records[i]
		for _, a := range rec.Attributes {
			if len(a.Values) > 0 && (ldap.IsPasswordAttribute(a.Name) || ldap.IsUnicodePwdAttribute(a.Name)) {
				return true
			}
		}
		for _, ch := range rec.Changes {
			if len(ch.Values) > 0 && (ldap.IsPasswordAttribute(ch.Attribute) || ldap.IsUnicodePwdAttribute(ch.Attribute)) {
				return true
			}
		}
	}
	return false
}

// markRecordsNotProcessed reports the remaining records of a stopped run.
func markRecordsNotProcessed(res *models.BulkApplyResult, recs []ldif.ChangeRecord, reason string) {
	res.Stopped = true
	if res.StopReason == "" {
		res.StopReason = reason
	}
	for _, rec := range recs {
		addResultItem(res, models.BulkResultItem{Line: rec.Line, DN: rec.DN, Operation: rec.ChangeType, Status: models.BulkResultNotProcessed, Message: reason})
	}
}

// OpenLDIFFile shows an open dialog and returns the chosen LDIF file
// (UTF-8 text, at most 64 MiB). Returns nil when the dialog was cancelled.
func (s *ExportService) OpenLDIFFile() (*models.LDIFFile, error) {
	path, err := runtime.OpenFileDialog(s.ctx, runtime.OpenDialogOptions{
		Title: "Open LDIF",
		Filters: []runtime.FileFilter{
			{DisplayName: "LDIF Files (*.ldif, *.ldf)", Pattern: "*.ldif;*.ldf"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("open dialog failed: %w", err)
	}
	if path == "" {
		return nil, nil
	}
	return readLDIFFile(path)
}

// readLDIFFile reads an LDIF file for the import dialog.
func readLDIFFile(path string) (*models.LDIFFile, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("cannot read %s: %w", path, err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("%s is a directory", path)
	}
	if info.Size() > maxLDIFFileSize {
		return nil, fmt.Errorf("%s is too large (%d bytes, limit %d MiB)", path, info.Size(), maxLDIFFileSize>>20)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("cannot read %s: %w", path, err)
	}
	if !utf8.Valid(data) {
		return nil, errors.New("the file is not UTF-8 text; LDIF values that are not UTF-8 must be base64 encoded (attr:: value)")
	}
	return &models.LDIFFile{Path: path, Name: filepath.Base(path), Size: info.Size(), Content: string(data)}, nil
}

// SaveReportFile shows a save dialog and writes content (a result report
// generated by the frontend) to the chosen file. Returns the path, or ""
// when the dialog was cancelled.
func (s *ExportService) SaveReportFile(defaultFilename string, content string) (string, error) {
	ext := strings.ToLower(filepath.Ext(defaultFilename))
	filters := []runtime.FileFilter{{DisplayName: "All Files (*.*)", Pattern: "*.*"}}
	switch ext {
	case ".csv":
		filters = append([]runtime.FileFilter{{DisplayName: "CSV Files (*.csv)", Pattern: "*.csv"}}, filters...)
	case ".ldif":
		filters = append([]runtime.FileFilter{{DisplayName: "LDIF Files (*.ldif)", Pattern: "*.ldif"}}, filters...)
	case ".txt":
		filters = append([]runtime.FileFilter{{DisplayName: "Text Files (*.txt)", Pattern: "*.txt"}}, filters...)
	}
	path, err := runtime.SaveFileDialog(s.ctx, runtime.SaveDialogOptions{
		Title:                "Save Report",
		DefaultFilename:      defaultFilename,
		CanCreateDirectories: true,
		Filters:              filters,
	})
	if err != nil {
		return "", fmt.Errorf("save dialog failed: %w", err)
	}
	if path == "" {
		return "", nil
	}
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		return "", fmt.Errorf("failed to write %s: %w", path, err)
	}
	return path, nil
}
