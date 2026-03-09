# LDAPilot Feature Batch: Container, Security, Batch Ops, Schema Validation

**Date**: 2026-03-09
**Status**: Approved

## Scope

4 work areas, no SASL/Kerberos in this iteration:

1. OpenLDAP Demo Container (200-500 entries)
2. Security Fixes (from CVE audit)
3. Batch Operations (Delete, Modify, Move)
4. Schema Validation (pre-write checks)

---

## 1. OpenLDAP Demo Container

### Structure

```
docker/
  docker-compose.yml
  seed/
    01-base.ldif           # Base DN + OU hierarchy
    02-users.ldif          # ~200 users with realistic attributes
    03-groups.ldif         # ~50 groups (nested, various types)
    04-services.ldif       # Service accounts, devices, policies
    05-extended.ldif       # Edge cases: binary attrs, long DNs, special chars
```

### Configuration

- **Image**: `osixia/openldap:1.5.0`
- **Base DN**: `dc=demo,dc=ldapilot,dc=local`
- **Admin**: `cn=admin,dc=demo,dc=ldapilot,dc=local` / `admin`
- **Read-only user**: `cn=readonly,dc=demo,dc=ldapilot,dc=local` / `readonly`
- **Ports**: 389 (LDAP), 636 (LDAPS)
- **Optional**: phpLDAPadmin on port 8080
- **TLS**: Self-signed cert for StartTLS/LDAPS testing

### OU Hierarchy

```
dc=demo,dc=ldapilot,dc=local
  ou=People
    ou=Engineering        (~60 users)
    ou=Sales              (~40 users)
    ou=Management         (~15 users)
    ou=HR                 (~20 users)
    ou=IT                 (~30 users)
    ou=Finance            (~15 users)
    ou=Contractors        (~20 users)
  ou=Groups
    ou=Teams              (~15 groups)
    ou=Roles              (~15 groups)
    ou=Distribution       (~10 groups)
    ou=Security           (~10 groups)
  ou=Services             (~15 service accounts)
  ou=Devices              (~20 device entries)
  ou=Policies             (~5 policy entries)
```

### Entry Details (~300-400 total)

**Users** (inetOrgPerson + posixAccount): ~200
- Realistic names (mix of German, English, international)
- Multi-value: mail, telephoneNumber, description
- Manager references (manager attribute pointing to other users)
- Various states: active, disabled (via description), different departments
- Some with jpegPhoto (small base64 image)
- posixAccount overlay for ~50 users (uid, gidNumber, homeDirectory)

**Groups** (~50):
- groupOfNames with member lists
- posixGroup with memberUid
- Nested groups (group containing groups)
- Empty groups (edge case)
- Large group (50+ members)

**Service accounts** (~15):
- applicationProcess, device objectClasses
- Service descriptions, ports, protocols

**Edge cases**:
- DN with special characters (commas, plus, spaces)
- Binary attributes (userCertificate simulation)
- Long description values (>1000 chars)
- Entries with many objectClasses (5+)
- UTF-8 attribute values (German umlauts, accented chars)

---

## 2. Security Fixes

### 2a. Export File Permissions
- **Files**: `services/export_service.go`, `services/connection_service.go`
- **Change**: All `os.WriteFile` calls use `0600` instead of `0644`
- **Scope**: LDIF export, CSV export, connection profile export

### 2b. Password Export Warning
- **File**: `services/connection_service.go` (ExportConnections)
- **Change**: Before export, check if any profile has a password. If yes, show Wails `MessageDialog` warning.
- **Message**: "Exported file will contain passwords in plaintext. Store the file securely."

### 2c. TLS Skip-Verify Warning
- **File**: `frontend/src/components/connection/ConnectionDialog.tsx`
- **Change**: Yellow warning icon + tooltip when TLS Skip Verify checkbox is checked
- **Text**: "Certificate validation disabled - connection vulnerable to MITM attacks"

---

## 3. Batch Operations

### Backend: BatchService

**File**: `services/batch_service.go`

```go
type BatchService struct {
    ctx    context.Context
    pool   *ldap.Pool
    editor *EditorService
    logger *LogService
}

type BatchResult struct {
    Total     int           `json:"total"`
    Succeeded int           `json:"succeeded"`
    Failed    int           `json:"failed"`
    Errors    []BatchError  `json:"errors"`
}

type BatchError struct {
    DN      string `json:"dn"`
    Message string `json:"message"`
}

type BatchModifyChange struct {
    Operation string   `json:"operation"` // "add", "replace", "delete"
    Attribute string   `json:"attribute"`
    Values    []string `json:"values"`
}
```

**Methods**:
- `BatchDelete(profileID string, dns []string) BatchResult`
- `BatchModify(profileID string, dns []string, changes []BatchModifyChange) BatchResult`
- `BatchMove(profileID string, dns []string, newParentDN string) BatchResult`

**Progress**: Wails runtime event `batch:progress` emitted per entry:
```json
{"current": 5, "total": 20, "currentDN": "cn=user5,ou=People,...", "operation": "delete"}
```

**Error handling**: Continue on individual failures, collect all errors in BatchResult.

### Frontend: BatchOperationDialog

**File**: `frontend/src/components/editor/BatchOperationDialog.tsx`

**Trigger**: TreeContextMenu when `selectedNodes.size > 1`

**3 tabs/modes**:
1. **Delete**: Confirm deletion of N entries, shows DN list
2. **Modify**: Attribute name + value + operation selector
3. **Move**: Target parent DN picker (tree or text input)

**UI flow**:
1. Select entries in tree (multi-select)
2. Right-click → "Batch Operations..."
3. Choose operation tab
4. Configure (for Modify/Move)
5. Confirm → Progress bar with live counter
6. Result summary (green/red counts + error details expandable)

### Wails binding

Register in `main.go`:
```go
batchService := services.NewBatchService(pool, editorService, logService)
// Add to Bind list
```

### Frontend types

```typescript
interface BatchResult {
    total: number;
    succeeded: number;
    failed: number;
    errors: BatchError[];
}
```

---

## 4. Schema Validation

### Backend Enhancement

**File**: `services/schema_service.go` (extend existing)

New methods:
- `GetObjectClassDetails(profileID, name string) ObjectClassInfo`
- `ValidateEntry(profileID string, objectClasses []string, attributes map[string][]string) []ValidationError`

```go
type ObjectClassInfo struct {
    Name        string   `json:"name"`
    OID         string   `json:"oid"`
    Description string   `json:"description"`
    Superior    []string `json:"superior"`
    Must        []string `json:"must"`
    May         []string `json:"may"`
    Type        string   `json:"type"` // structural, auxiliary, abstract
}

type ValidationError struct {
    Attribute string `json:"attribute"`
    Message   string `json:"message"`
    Type      string `json:"type"` // "missing_required", "unknown_attribute", "syntax_error"
}
```

Validation checks:
1. All MUST attributes present (walk inheritance chain via SUP)
2. All provided attributes are in MUST or MAY (or inherited)
3. At least one structural objectClass present

### Frontend Integration

**Files**: `NewEntryDialog.tsx`, `EditEntryDialog.tsx`

Changes:
- On objectClass selection change → fetch MUST/MAY via `GetObjectClassDetails`
- Show required attributes with red asterisk
- Pre-populate MUST attributes as empty fields
- On submit → call `ValidateEntry` first, show errors inline
- Block submit if validation fails

No new dialog needed - enhances existing ones.

---

## Implementation Order

1. Docker container (foundation for testing everything else)
2. Security fixes (quick wins, no architecture changes)
3. Schema validation (needed by batch ops for safety)
4. Batch operations (uses schema validation, benefits from test container)
