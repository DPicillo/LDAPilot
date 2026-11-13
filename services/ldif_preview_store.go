package services

import (
	"fmt"
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/models"
)

// A dry run of a large file keeps its records in Go: the dialog gets the
// first records of every status at once and pages through the rest with
// GetLDIFPreviewRecords, instead of receiving every record (100,000 add
// records were 126 MB of JSON over the Wails bridge).

const (
	// ldifPreviewInline: files with up to this many records send every
	// record with the dry run.
	ldifPreviewInline = 500
	// ldifPreviewFirst is the number of records per status (and of the
	// file) a larger dry run sends at once.
	ldifPreviewFirst = 200
	// ldifPreviewKeep is how long the records of a dry run stay readable.
	ldifPreviewKeep = time.Hour
	// ldifPreviewRuns is the number of dry runs kept (the newest).
	ldifPreviewRuns = 4
	// ldifPreviewPageMax caps one page.
	ldifPreviewPageMax = 5000
)

type ldifPreviewEntry struct {
	records []models.LDIFRecordPreview
	// content is the file of the newest dry run, so its apply need not send
	// it again (BulkOptions.PreviewRunID); "" for older runs.
	content string
	at      time.Time
}

var ldifPreviews = struct {
	sync.Mutex
	m     map[string]*ldifPreviewEntry
	order []string
}{m: map[string]*ldifPreviewEntry{}}

// keepLDIFPreview stores the records (and the content) of a dry run under
// runID and trims preview.Records to what the dialog shows first (Partial).
// Small files and runs without an ID are returned whole.
func keepLDIFPreview(runID string, preview *models.LDIFPreview, content string) {
	if runID == "" || len(preview.Records) <= ldifPreviewInline {
		return
	}
	ldifPreviews.Lock()
	now := time.Now()
	for id, e := range ldifPreviews.m {
		if now.Sub(e.at) > ldifPreviewKeep {
			delete(ldifPreviews.m, id)
		}
	}
	if _, ok := ldifPreviews.m[runID]; !ok {
		ldifPreviews.order = append(ldifPreviews.order, runID)
	}
	for _, e := range ldifPreviews.m {
		e.content = "" // only the newest file is kept (64 MiB at most)
	}
	ldifPreviews.m[runID] = &ldifPreviewEntry{records: preview.Records, content: content, at: now}
	kept := ldifPreviews.order[:0]
	for _, id := range ldifPreviews.order {
		if _, ok := ldifPreviews.m[id]; ok {
			kept = append(kept, id)
		}
	}
	for len(kept) > ldifPreviewRuns {
		delete(ldifPreviews.m, kept[0])
		kept = kept[1:]
	}
	ldifPreviews.order = kept
	ldifPreviews.Unlock()

	preview.Records = firstLDIFRecords(preview.Records, ldifPreviewFirst)
	preview.Partial = true
	preview.RunID = runID
}

// firstLDIFRecords returns the first n records of the file plus the first n
// of every status, in file order: for every status filter of the dialog
// they are the start of its list.
func firstLDIFRecords(records []models.LDIFRecordPreview, n int) []models.LDIFRecordPreview {
	perStatus := map[string]int{}
	out := make([]models.LDIFRecordPreview, 0, 2*n)
	for i, r := range records {
		perStatus[r.Status]++
		if i < n || perStatus[r.Status] <= n {
			out = append(out, r)
		}
	}
	return out
}

// pageLDIFRecords returns the records with status ("" or "all": every
// record) from offset on, at most limit.
func pageLDIFRecords(records []models.LDIFRecordPreview, status string, offset, limit int) models.LDIFRecordPage {
	if limit <= 0 || limit > ldifPreviewPageMax {
		limit = ldifPreviewPageMax
	}
	page := models.LDIFRecordPage{Records: []models.LDIFRecordPreview{}}
	for _, r := range records {
		if status != "" && status != "all" && r.Status != status {
			continue
		}
		if page.Total >= offset && len(page.Records) < limit {
			page.Records = append(page.Records, r)
		}
		page.Total++
	}
	return page
}

// keptLDIFContent returns the file of a kept dry run (the newest one only).
func keptLDIFContent(runID string) (string, bool) {
	ldifPreviews.Lock()
	defer ldifPreviews.Unlock()
	if e := ldifPreviews.m[runID]; e != nil && e.content != "" && time.Since(e.at) <= ldifPreviewKeep {
		return e.content, true
	}
	return "", false
}

// GetLDIFPreviewRecords returns records of a large dry run (LDIFPreview.Partial)
// by status ("all" or an LDIFRecord* status) from offset on, at most limit
// (≤ 5000). The records stay readable for an hour (the newest four dry runs).
func (s *ExportService) GetLDIFPreviewRecords(runID string, status string, offset, limit int) (*models.LDIFRecordPage, error) {
	ldifPreviews.Lock()
	e := ldifPreviews.m[runID]
	ldifPreviews.Unlock()
	if e == nil {
		return nil, fmt.Errorf("the dry run is no longer available; run it again")
	}
	page := pageLDIFRecords(e.records, status, offset, limit)
	return &page, nil
}
