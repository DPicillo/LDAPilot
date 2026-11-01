package services

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/internal/models"
	goldap "github.com/go-ldap/ldap/v3"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Deleted objects (AD tombstones / Recycle Bin), restore and subtree
// delete. Reads are BrowserService methods, writes EditorService methods
// (read-only enforced, audited).

// SubtreeDeleteProgressEvent is the Wails event carrying
// models.SubtreeDeleteProgress.
const SubtreeDeleteProgressEvent = "recycle:delete-progress"

// --- BrowserService (reads) ---

// GetRecycleBinInfo reports whether the connected server offers AD deleted
// objects, whether the AD Recycle Bin is enabled, the configured lifetimes
// and the Deleted Objects container of each naming context. For non-AD
// servers Supported is false and Reason explains why.
func (s *BrowserService) GetRecycleBinInfo(profileID string) (*models.RecycleBinInfo, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.RecycleBinInfo()
}

// ListDeletedObjects lists the deleted objects of a naming context (empty =
// the default naming context). filter, if set, matches name, last known RDN
// and sAMAccountName (substring). sizeLimit <= 0 uses the default (5000).
func (s *BrowserService) ListDeletedObjects(profileID string, namingContext string, filter string, sizeLimit int) (*models.DeletedObjectsList, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.ListDeletedObjects(namingContext, filter, sizeLimit)
}

// GetDeletedObjectEntry returns all attributes a deleted object still has.
func (s *BrowserService) GetDeletedObjectEntry(profileID string, dn string) (*models.LDAPEntry, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.GetDeletedEntry(dn)
}

// CountDescendants counts the entries below dn (capped at 10000) and tells
// whether the server supports the tree delete control.
func (s *BrowserService) CountDescendants(profileID string, dn string) (*models.DescendantCount, error) {
	if dn == "" {
		return nil, fmt.Errorf("DN must not be empty")
	}
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	count, capped, err := client.CountDescendants(dn, ldap.DefaultDescendantLimit)
	if err != nil {
		return nil, err
	}
	out := &models.DescendantCount{
		DN:                  dn,
		Count:               count,
		Capped:              capped,
		Limit:               ldap.DefaultDescendantLimit,
		TreeDeleteSupported: client.TreeDeleteSupported(),
	}
	if info, err := client.ServerInfo(); err == nil {
		out.ServerType = info.ServerType
	}
	return out, nil
}

// --- BrowserService: lifecycle helpers (create / copy / move / restore) ---

// EntriesExist checks whether the entries exist (target containers of move,
// copy, create and restore dialogs). Base searches without attributes; not
// written to the operation log. At most 200 DNs.
func (s *BrowserService) EntriesExist(profileID string, dns []string) ([]models.EntryCheck, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.EntriesExist(dns), nil
}

// LoginNameHolders returns up to 5 DNs of entries whose attribute attr
// (uid, sAMAccountName, userPrincipalName, mail, cn, uidNumber, gidNumber)
// equals value: duplicate checks of new accounts and copies. Searched below
// the default naming context on AD (sAMAccountName is unique per domain),
// else below the profile base DN, else every naming context.
func (s *BrowserService) LoginNameHolders(profileID string, attr string, value string) ([]string, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.LoginNameHolders(lifecycleSearchBases(client), attr, value, 5)
}

// NextPosixIDs returns the next free uidNumber and gidNumber (highest used
// ID from 1000 to 59999 + 1, or 10000) and the primary gidNumber most
// accounts use, below the profile base DN or every naming context.
func (s *BrowserService) NextPosixIDs(profileID string) (*models.PosixIDs, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	uid, gid, common, err := client.NextPosixIDs(lifecycleSearchBases(client))
	if err != nil {
		return nil, err
	}
	return &models.PosixIDs{UIDNumber: uid, GIDNumber: gid, PrimaryGIDNumber: common}, nil
}

// UPNSuffixes returns the user principal name suffixes an AD forest offers:
// the domain of the connection first, the other domains, then the
// alternative uPNSuffixes of CN=Partitions. Non-AD servers: none.
func (s *BrowserService) UPNSuffixes(profileID string) ([]string, error) {
	client, err := s.pool.Get(profileID)
	if err != nil {
		return nil, err
	}
	return client.UPNSuffixes()
}

// lifecycleSearchBases are the subtrees duplicate and ID searches cover: AD
// the default naming context, others the profile base DN, else every naming
// context of the server.
func lifecycleSearchBases(client *ldap.Client) []string {
	base := strings.TrimSpace(client.Profile().BaseDN)
	info, err := client.ServerInfo()
	if err != nil {
		if base != "" {
			return []string{base}
		}
		return []string{""}
	}
	if info.ServerType == models.ServerTypeAD && info.DefaultNamingContext != "" {
		return []string{info.DefaultNamingContext}
	}
	if base != "" {
		return []string{base}
	}
	if len(info.NamingContexts) > 0 {
		return info.NamingContexts
	}
	if info.DefaultNamingContext != "" {
		return []string{info.DefaultNamingContext}
	}
	return []string{""}
}

// --- EditorService (writes) ---

// RestoreDeletedObjects restores (reanimates) deleted objects. Each request
// is restored into its TargetParentDN (default: the last known parent) under
// NewName (default: the original name). An object whose deleted container is
// requested in the same call is restored after it and into it (whatever
// TargetParentDN says), so a deleted OU and its deleted children come back
// as a tree, also with "restore to"; when that container fails, the object
// fails with parentDeleted. Every attempt is audited as RESTORE; failures
// carry an ErrorKind (parentMissing, parentDeleted, conflict, permission,
// ...). A read-only connection returns ErrReadOnly.
func (s *EditorService) RestoreDeletedObjects(profileID string, requests []models.RestoreRequest) ([]models.RestoreResult, error) {
	if len(requests) == 0 {
		return []models.RestoreResult{}, nil
	}
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return nil, err
	}

	// Read all objects first to order parents before children.
	objs := make([]*models.DeletedObject, len(requests))
	readErrs := make([]error, len(requests))
	for i, req := range requests {
		objs[i], readErrs[i] = client.GetDeletedObject(req.DN)
	}
	order := restoreOrder(requests, objs)

	requested := map[string]bool{} // normalized DNs of all requested objects
	for _, req := range requests {
		requested[ldap.RecycleDNKey(req.DN)] = true
	}
	results := make([]models.RestoreResult, len(requests))
	restoredTo := map[string]string{} // normalized deleted DN -> restored DN
	oidName := restoreOIDNames(client)
	for _, i := range order {
		req := requests[i]
		obj, readErr := objs[i], readErrs[i]
		var res models.RestoreResult
		if parentKey := deletedParentKey(obj, readErr); parentKey != "" && requested[parentKey] {
			if target, ok := restoredTo[parentKey]; ok {
				// The deleted container was restored in this call: the object
				// follows it, also when a target container was chosen for the
				// whole selection (the restored structure is kept).
				req.TargetParentDN = target
				res = s.restoreOne(client, profileID, req, obj, nil)
			} else {
				res = models.RestoreResult{DN: req.DN, Name: obj.Name, ErrorKind: models.RestoreErrParentDeleted,
					Error: fmt.Sprintf("Its container %s was selected as well but could not be restored (see its error). Restore the container first, or restore this object on its own into another container.", deletedParentDisplayName(obj.LastKnownParent))}
			}
		} else {
			res = s.restoreOne(client, profileID, req, obj, readErr)
		}
		if res.Success {
			restoredTo[ldap.RecycleDNKey(req.DN)] = res.TargetDN
			describeRestored(client, &res, obj, oidName)
		}
		results[i] = res
	}
	return results, nil
}

// restoreOIDNames returns a lazy OID → attribute name lookup over the
// schema (read once per restore call, on first use; "" when unknown).
func restoreOIDNames(client *ldap.Client) func(oid string) string {
	var names map[string]string
	return func(oid string) string {
		if names == nil {
			names = map[string]string{}
			if schema, err := client.GetSchema(); err == nil && schema != nil {
				for _, a := range schema.Attributes {
					if a.OID != "" && a.Name != "" {
						names[a.OID] = a.Name
					}
				}
			}
		}
		return names[oid]
	}
}

// describeRestored fills the state of a restored object and, for a
// tombstone, what it came back without (replication metadata of the
// restored entry) and that its group memberships are gone. Failures only
// leave Without empty.
func describeRestored(client *ldap.Client, res *models.RestoreResult, obj *models.DeletedObject, oidName func(string) string) {
	if obj == nil {
		return
	}
	res.State = obj.State
	if obj.State != models.DeletedStateTombstone {
		// Recycle Bin: a deleted object keeps its attributes and links; the
		// metadata would only name attributes cleared before the deletion.
		return
	}
	res.LinksRemoved = true
	if names, other, err := client.RestoredWithout(res.TargetDN, oidName); err == nil {
		res.Without, res.WithoutOther = names, other
	}
}

// deletedParentKey returns the normalized DN of the deleted container a
// readable deleted object was deleted from, or "" when its last known parent
// is not deleted.
func deletedParentKey(obj *models.DeletedObject, readErr error) string {
	if readErr != nil || obj == nil || !obj.ParentDeleted {
		return ""
	}
	return ldap.RecycleDNKey(obj.LastKnownParent)
}

// restoreOne restores one deleted object.
func (s *EditorService) restoreOne(client *ldap.Client, profileID string, req models.RestoreRequest, obj *models.DeletedObject, readErr error) models.RestoreResult {
	res := models.RestoreResult{DN: req.DN}
	fail := func(kind, msg string) models.RestoreResult {
		res.ErrorKind, res.Error = kind, msg
		return res
	}
	if readErr != nil {
		if errors.Is(readErr, ldap.ErrNotFound) || goldap.IsErrorWithCode(readErr, goldap.LDAPResultNoSuchObject) {
			return fail(models.RestoreErrNotFound, "The deleted object cannot be read: it no longer exists (already restored, or purged after its lifetime expired), or this account is not allowed to see deleted objects (by default only administrators are).")
		}
		return fail(models.RestoreErrOther, readErr.Error())
	}
	res.Name = obj.Name
	if !obj.Restorable {
		return fail(models.RestoreErrNotRestorable, "This object is recycled: the AD Recycle Bin no longer keeps its attributes, so it cannot be restored.")
	}

	parent := strings.TrimSpace(req.TargetParentDN)
	if parent == "" {
		parent = obj.LastKnownParent
	}
	if parent == "" {
		return fail(models.RestoreErrParentMissing, "The original location is unknown (no lastKnownParent). Choose a target container with \"Restore to…\".")
	}
	if ldap.IsDeletedObjectDN(parent) {
		return fail(models.RestoreErrParentDeleted, fmt.Sprintf("The original container is deleted as well (%s). Restore that container first (select both — containers are restored before their children) or choose another target container.", deletedParentDisplayName(parent)))
	}
	if exists, err := client.LiveEntryExists(parent); err == nil && !exists {
		return fail(models.RestoreErrParentMissing, fmt.Sprintf("The target container %s does not exist. Choose another container with \"Restore to…\".", parent))
	}

	name := strings.TrimSpace(req.NewName)
	if name == "" {
		name = obj.Name
	}
	if obj.RDNAttribute == "" || name == "" {
		return fail(models.RestoreErrOther, "Cannot determine the original RDN of the deleted object.")
	}
	res.Name = name
	res.TargetDN = ldap.BuildRestoreDN(obj.RDNAttribute, name, parent)

	if obj.SAMAccountName != "" {
		if nc := ldap.DeletedObjectNamingContext(obj.DN); nc != "" {
			if holder, err := client.SAMAccountNameUser(nc, obj.SAMAccountName); err == nil && holder != "" {
				return fail(models.RestoreErrConflict, fmt.Sprintf("The sAMAccountName %q is already used by %s. Rename or remove that account before restoring this one.", obj.SAMAccountName, holder))
			}
		}
	}

	err := client.RestoreDeletedObject(obj.DN, res.TargetDN)
	s.audit(profileID, "RESTORE", res.TargetDN, fmt.Sprintf("restored %s object from %s", obj.State, obj.DN), err)
	if err != nil {
		kind := ldap.ClassifyRestoreError(err)
		return fail(kind, restoreErrorMessage(kind, err, res.TargetDN, parent))
	}
	res.Success = true
	return res
}

// restoreErrorMessage explains a failed restore.
func restoreErrorMessage(kind string, err error, targetDN, parent string) string {
	switch kind {
	case models.RestoreErrConflict:
		return fmt.Sprintf("An object with this name or a unique attribute (e.g. sAMAccountName, userPrincipalName) already exists: %s. Restore it under a different name or into another container. (%v)", targetDN, err)
	case models.RestoreErrPermission:
		return fmt.Sprintf("Insufficient rights. Restoring needs the \"Reanimate Tombstones\" extended right on the domain and create rights on %s (Domain Admins have both). (%v)", parent, err)
	case models.RestoreErrParentMissing:
		return fmt.Sprintf("The target container %s does not exist (or the deleted object is gone). Choose another container. (%v)", parent, err)
	case models.RestoreErrInvalidTarget:
		return fmt.Sprintf("The object cannot be placed in %s (naming or object class rules). Choose another container. (%v)", parent, err)
	case models.RestoreErrNotRestorable:
		return fmt.Sprintf("The server refused to restore this object. (%v)", err)
	}
	return err.Error()
}

// deletedParentDisplayName shortens a deleted container's DN to its original name.
func deletedParentDisplayName(dn string) string {
	rdn := dn
	if parent := ldap.RecycleParentDN(dn); parent != "" {
		rdn = strings.TrimSuffix(dn[:len(dn)-len(parent)], ",")
	}
	if i := strings.Index(strings.ToLower(rdn), "\\0adel:"); i >= 0 {
		rdn = rdn[:i]
	}
	return rdn
}

// restoreOrder returns the indexes of requests so that an object comes after
// every selected object on its chain of last known parents.
func restoreOrder(requests []models.RestoreRequest, objs []*models.DeletedObject) []int {
	index := map[string]int{}
	for i, req := range requests {
		index[ldap.RecycleDNKey(req.DN)] = i
	}
	depth := make([]int, len(requests))
	for i := range requests {
		d := 0
		seen := map[int]bool{i: true}
		for cur := i; objs[cur] != nil; {
			p, ok := index[ldap.RecycleDNKey(objs[cur].LastKnownParent)]
			if !ok || seen[p] {
				break
			}
			seen[p] = true
			d++
			cur = p
		}
		depth[i] = d
	}
	order := make([]int, len(requests))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return depth[order[a]] < depth[order[b]] })
	return order
}

// subtreeOps holds the cancel functions of running subtree deletes.
var subtreeOps = struct {
	sync.Mutex
	m map[string]context.CancelFunc
}{m: map[string]context.CancelFunc{}}

// CancelSubtreeDelete stops a running client-side subtree delete after the
// entry being deleted; it returns false when no such operation runs. A
// server-side tree delete is a single request and cannot be stopped.
func (s *EditorService) CancelSubtreeDelete(operationID string) bool {
	subtreeOps.Lock()
	defer subtreeOps.Unlock()
	if cancel, ok := subtreeOps.m[operationID]; ok {
		cancel()
		return true
	}
	return false
}

func (s *EditorService) emitSubtreeProgress(p models.SubtreeDeleteProgress) {
	if s.ctx == nil {
		return
	}
	wailsRuntime.EventsEmit(s.ctx, SubtreeDeleteProgressEvent, p)
}

// DeleteSubtree deletes dn including all entries below it. It refuses to
// run unless options.Confirmed is set. With method "auto" the tree delete
// control is used when the server supports it (one request, audited as one
// TREE_DELETE entry), otherwise the subtree is deleted client-side, deepest
// entries first, each audited as DELETE, with "recycle:delete-progress"
// events, CancelSubtreeDelete and stop/continue on error (ancestors of a
// failed entry are skipped). The result reports what was deleted.
func (s *EditorService) DeleteSubtree(profileID string, dn string, options models.SubtreeDeleteOptions) (*models.SubtreeDeleteResult, error) {
	if dn == "" {
		return nil, fmt.Errorf("DN must not be empty")
	}
	if !options.Confirmed {
		return nil, fmt.Errorf("recursive delete of %s needs an explicit confirmation", dn)
	}
	client, err := s.getWritableClient(profileID)
	if err != nil {
		return nil, err
	}
	method, err := resolveSubtreeMethod(options.Method, client.TreeDeleteSupported())
	if err != nil {
		return nil, err
	}
	isAD := false
	if info, err := client.ServerInfo(); err == nil {
		isAD = info.ServerType == models.ServerTypeAD
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if options.OperationID != "" {
		subtreeOps.Lock()
		subtreeOps.m[options.OperationID] = cancel
		subtreeOps.Unlock()
		defer func() {
			subtreeOps.Lock()
			delete(subtreeOps.m, options.OperationID)
			subtreeOps.Unlock()
		}()
	}

	start := time.Now()
	progress := models.SubtreeDeleteProgress{OperationID: options.OperationID, DN: dn, Method: method}
	var result *models.SubtreeDeleteResult
	if method == models.SubtreeDeleteTreeDelete {
		result = s.treeDelete(client, profileID, dn, isAD, progress)
	} else {
		result, err = s.clientSideDelete(ctx, client, profileID, dn, options.StopOnError, isAD, progress)
		if err != nil {
			// The run sent "enumerating" and ends here: say so, or listeners
			// (the quit guard) would count it as running.
			progress.Phase = "done"
			s.emitSubtreeProgress(progress)
			return nil, err
		}
	}
	result.DurationMs = time.Since(start).Milliseconds()

	progress.Phase, progress.Total, progress.Current = "done", result.Total, result.Deleted+result.Failed+result.Skipped
	progress.Deleted, progress.Failed, progress.CurrentDN = result.Deleted, result.Failed, ""
	s.emitSubtreeProgress(progress)
	return result, nil
}

// resolveSubtreeMethod picks the delete method.
func resolveSubtreeMethod(method string, treeDeleteSupported bool) (string, error) {
	switch method {
	case "", models.SubtreeDeleteAuto:
		if treeDeleteSupported {
			return models.SubtreeDeleteTreeDelete, nil
		}
		return models.SubtreeDeleteClientSide, nil
	case models.SubtreeDeleteTreeDelete:
		if !treeDeleteSupported {
			return "", fmt.Errorf("the server does not support the tree delete control (%s)", ldap.OIDTreeDelete)
		}
		return method, nil
	case models.SubtreeDeleteClientSide:
		return method, nil
	}
	return "", fmt.Errorf("unknown delete method %q", method)
}

// treeDelete deletes the subtree with the tree delete control.
func (s *EditorService) treeDelete(client *ldap.Client, profileID, dn string, isAD bool, progress models.SubtreeDeleteProgress) *models.SubtreeDeleteResult {
	result := &models.SubtreeDeleteResult{DN: dn, Method: models.SubtreeDeleteTreeDelete, Total: -1, Errors: []models.SubtreeDeleteError{}}
	descendants, capped, cerr := client.CountDescendants(dn, ldap.DefaultDescendantLimit)
	countText := "unknown number of"
	if cerr == nil {
		result.Total, result.TotalCapped = descendants+1, capped
		countText = fmt.Sprint(descendants)
		if capped {
			countText = fmt.Sprintf("more than %d", descendants)
		}
	}

	// Current stays 0: a tree delete is one request without progress.
	progress.Phase, progress.Total, progress.CurrentDN = "deleting", result.Total, dn
	s.emitSubtreeProgress(progress)

	err := client.TreeDelete(dn)
	s.audit(profileID, "TREE_DELETE", dn, fmt.Sprintf("tree delete control %s, %s descendants", ldap.OIDTreeDelete, countText), err)
	if err == nil {
		result.Deleted = max(result.Total, 1)
		recordDeletedDN(result, dn)
		return result
	}
	message := subtreeDeleteErrorMessage(err, isAD)
	// AD deletes large trees in several transactions (and gives up with
	// adminLimitExceeded), so part of the subtree may be gone: look at what
	// is left.
	deleted, unknown, gone := treeDeleteLeftover(client, dn, result.Total, result.TotalCapped)
	switch {
	case gone:
		// Not visible any more: deleted by the server before the error
		// (e.g. the connection dropped), or not readable for this account.
		result.DeletedUnknown = true
		message += " — the entry is no longer found; the tree may have been deleted"
	case unknown:
		result.DeletedUnknown = true
		message += " — some entries below it may already have been deleted"
	case deleted > 0:
		result.Deleted = deleted
		message += fmt.Sprintf(" — %d entries below it were deleted before the error", deleted)
	}
	result.Failed = 1
	result.Errors = append(result.Errors, models.SubtreeDeleteError{DN: dn, Message: message})
	return result
}

// treeDeleteLeftover finds out what a failed tree delete of dn removed:
// gone = dn is not found any more; otherwise deleted is the number of entries
// that disappeared compared to total (counted before, incl. dn), or unknown
// is true when that cannot be determined (no or capped count before, or the
// subtree cannot be read now).
func treeDeleteLeftover(client *ldap.Client, dn string, total int, totalCapped bool) (deleted int, unknown, gone bool) {
	exists, err := client.LiveEntryExists(dn)
	if err != nil {
		return 0, true, false
	}
	if !exists {
		return 0, false, true
	}
	if total <= 0 || totalCapped {
		return 0, true, false
	}
	remaining, capped, err := client.CountDescendants(dn, ldap.DefaultDescendantLimit)
	if err != nil || capped {
		return 0, true, false
	}
	return leftoverDeleted(total, remaining), false, false
}

// leftoverDeleted is the number of entries a failed tree delete removed:
// total (incl. the root, which still exists) minus what is left.
func leftoverDeleted(total, remainingDescendants int) int {
	return max(total-(remainingDescendants+1), 0)
}

// clientSideDelete deletes the subtree entry by entry, deepest first.
func (s *EditorService) clientSideDelete(ctx context.Context, client *ldap.Client, profileID, dn string, stopOnError, isAD bool, progress models.SubtreeDeleteProgress) (*models.SubtreeDeleteResult, error) {
	progress.Phase = "enumerating"
	s.emitSubtreeProgress(progress)

	dns, err := client.ListSubtreeDNs(dn)
	if err != nil {
		return nil, fmt.Errorf("could not list the entries below %s: %w", dn, err)
	}
	result := &models.SubtreeDeleteResult{DN: dn, Method: models.SubtreeDeleteClientSide, Total: len(dns), Errors: []models.SubtreeDeleteError{}}
	progress.Phase, progress.Total = "deleting", len(dns)

	blocked := map[string]bool{} // normalized DNs whose children could not be deleted
	block := func(entryDN string) {
		if parent := ldap.RecycleParentDN(entryDN); parent != "" {
			blocked[ldap.RecycleDNKey(parent)] = true
		}
	}
	lastEmit := time.Time{}
	for i, entryDN := range dns {
		if ctx.Err() != nil {
			result.Cancelled = true
			break
		}
		progress.Current, progress.CurrentDN = i+1, entryDN
		if blocked[ldap.RecycleDNKey(entryDN)] {
			result.Skipped++
			result.Errors = append(result.Errors, models.SubtreeDeleteError{DN: entryDN, Message: "skipped: an entry below it could not be deleted", Skipped: true})
			block(entryDN)
		} else {
			err := client.DeleteSubtreeEntry(entryDN)
			s.audit(profileID, "DELETE", entryDN, "subtree delete of "+dn, err)
			switch {
			case err == nil, goldap.IsErrorWithCode(err, goldap.LDAPResultNoSuchObject):
				// Gone already (e.g. deleted concurrently) is the wanted state.
				result.Deleted++
				recordDeletedDN(result, entryDN)
			default:
				result.Failed++
				result.Errors = append(result.Errors, models.SubtreeDeleteError{DN: entryDN, Message: subtreeDeleteErrorMessage(err, isAD)})
				block(entryDN)
				if stopOnError || errors.Is(err, ldap.ErrReadOnly) || errors.Is(err, ldap.ErrNotConnected) {
					progress.Deleted, progress.Failed = result.Deleted, result.Failed
					s.emitSubtreeProgress(progress)
					return result, nil
				}
			}
		}
		progress.Deleted, progress.Failed = result.Deleted, result.Failed
		if i == len(dns)-1 || time.Since(lastEmit) > 100*time.Millisecond {
			s.emitSubtreeProgress(progress)
			lastEmit = time.Now()
		}
	}
	return result, nil
}

// recordDeletedDN adds dn to the report's DeletedDNs (capped).
func recordDeletedDN(result *models.SubtreeDeleteResult, dn string) {
	if len(result.DeletedDNs) >= models.SubtreeDeletedDNsLimit {
		result.DeletedDNsTruncated = true
		return
	}
	result.DeletedDNs = append(result.DeletedDNs, dn)
}

// subtreeDeleteErrorMessage adds a hint to common delete failures.
func subtreeDeleteErrorMessage(err error, isAD bool) string {
	msg := strings.TrimSpace(err.Error())
	switch {
	case goldap.IsErrorWithCode(err, goldap.LDAPResultInsufficientAccessRights) && isAD:
		return msg + " — insufficient rights (the object may also be protected from accidental deletion)"
	case goldap.IsErrorWithCode(err, goldap.LDAPResultInsufficientAccessRights):
		return msg + " — insufficient rights"
	case goldap.IsErrorWithCode(err, goldap.LDAPResultNotAllowedOnNonLeaf):
		return msg + " — the entry still has children"
	}
	return msg
}
