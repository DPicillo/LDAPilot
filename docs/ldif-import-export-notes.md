# LDIF import / export: notes (branch DPicillo/ldif-import-export)

Working notes for the task "LDIF-Import und -Export sollen anpassen statt
blockieren und mit vielen Einträgen schnell sein" (2026-11-13). Findings,
measurements and decisions are recorded here as they come.

## 1. Code reading (before reproducing)

- Import apply: `services/bulk_ldif.go` `ApplyLDIFChanges` → `applyRecord`;
  add = `AddEntryWithPasswordPolicy(rec.DN, rec.Attributes, pw)` as in the file.
- Dry run: `ldifSimulator.check`; add records: exists, parent, AD unique values,
  password plan. Modify records: `simulateChanges` (NO-USER-MODIFICATION etc.).
- Stop: `shouldStop` (`bulk_batch.go`) stops at the first failure unless
  ContinueOnError.
- Export: `ExportService.Export` → whole content string → frontend →
  `SaveExportFile(content)`.

## 2. Reproduction against the lab (2026-11-13, before any change)

Harness: `services/ldiflab_test.go` (`go test -tags ldiflab -run TestLDIFLab… -v ./services`),
calling `ExportService.Export` / `PreviewLDIFChanges` / `ApplyLDIFChanges` exactly as
the dialogs do, continue on error ON. Samples: OL `ou=IT,ou=People` (7 entries),
389DS `ou=IT,ou=People` (37), Samba `OU=Hamburg,OU=Users,OU=LDAPilot` (20); each
file rebased into an own OU on every server; plus a real `slapcat` of the OL sample.

| file → target | dry run | apply (messages as shown in the result) |
|---|---|---|
| OL importable → OL | 7 ok | 7 ok |
| OL importable → DS | 7 ok | 7 ok |
| OL not importable → OL | **7 ok** | 7 failed `Constraint Violation: structuralObjectClass: no user modification allowed` |
| OL not importable → DS | **7 ok** | 1 failed `Object Class Violation: attribute "entrycsn" not allowed`, the 6 children `No Such Object: ` (empty text: parent missing) |
| `slapcat` → OL / DS | **7 ok** | same as "not importable" |
| DS importable → OL | 36 warnings (PBKDF2 module) | 35 failed `Invalid Attribute Syntax: objectClass: value #4 invalid per syntax` (= `nsMemberOf`, unknown to OL) |
| DS not importable → OL | same | + `nsUniqueId: attribute type undefined`, `passwordExpirationTime: attribute type undefined` |
| DS → DS (both) | 37 ok | 37 ok (DS silently replaces nsUniqueId, entryUUID, timestamps) |
| OL/DS → AD | ok / AD userPassword warning | `Constraint Violation: 000020B5: Referenced object not found` (manager DN not on AD), `Invalid RDN 'UID' for objectclass 'inetOrgPerson'`, `createTimestamp … contains at least one invalid value` |
| AD not importable → AD | sAMAccountName errors (same DNs, base64 DNs not rebased by the harness) | `replmd_add: it's not allowed to add an object with objectGUID!`, `The primary group isn't settable on add operations!`, children `parent does not exist!` |
| AD → OL / DS | parent warnings | `objectClass: value #3 invalid per syntax` (`user`), `objectCategory` / `instanceType` undefined |

Findings:
- The dry run predicts none of the server-maintained / unknown-schema failures of add records.
- Children of a failed add are sent anyway and fail with the server's "No Such Object" (389DS: empty text).
- Without "Continue on error" every one of these runs ends at record 1.

### Per attribute (`TestLDIFLabProbe`, `TestLDIFLabProbeAD`)

OpenLDAP 2.4.57 (Relax Rules works but is not listed in supportedControl):
- refused without Relax, **stored with Relax**: entryUUID, createTimestamp, creatorsName, modifyTimestamp, modifiersName, pwdChangedTime, pwdHistory, pwdFailureTime, pwdGraceUseTime
- refused even with Relax ("not manageable"): entryCSN, structuralObjectClass, entryDN, hasSubordinates, subschemaSubentry
- accepted as is: pwdAccountLockedTime, pwdReset, pwdPolicySubentry, memberOf (overlay back-link, stored verbatim: wrong data), {SSHA} userPassword

389DS 3.1.2 (no Relax: critical → unavailableCriticalExtension):
- accepted but replaced by the server's own value: nsUniqueId, entryUUID, create/modifyTimestamp, creators/modifiersName, entryid, parentid, numSubordinates, dsEntryDN, entrydn, nsRole
- stored as given: passwordExpirationTime, passwordHistory, passwordRetryCount, accountUnlockTime, nsAccountLock, nsRoleDN, pwdHistory, {PBKDF2-SHA512} userPassword
- refused: memberOf (no nsMemberOf class), entryCSN

Samba AD:
- refused (also with Relax): objectGUID, objectSid, sAMAccountType, primaryGroupID (on add), isCriticalSystemObject, linked back-links (memberOf, directReports), pwdLastSet other than 0/-1, DN values of entries that do not exist (manager)
- accepted / overwritten: whenCreated/Changed, uSNCreated/Changed, instanceType, distinguishedName, name, objectCategory, dSCorePropagationData, badPwdCount, lastLogon, logonCount, lockoutTime 0
- a user with userAccountControl 512 and no password is accepted by Samba

## 3. Decisions (import adaptations)

New `BulkOptions.import` (`models.LDIFImportOptions`), decided once for the file
before the dry run; apply re-plans every record with the same simulator, so the
result matches the dry run of the current directory.

| option | default | effect |
|---|---|---|
| serverAttributes | omit | server-maintained attributes (static list of `internal/ldif` + target schema NO-USER-MODIFICATION) are left out and named per record. `send`: OpenLDAP keeps entryUUID / create+modify timestamp / creators+modifiersName / pwdChangedTime, pwdHistory, pwdFailureTime, pwdGraceUseTime (Relax Rules, non-critical); 389DS: sent except what it assigns itself (nsUniqueId, entryUUID, timestamps, …); AD: only nTSecurityDescriptor. Back-links (memberOf, directReports, managedObjects, nsRole) are never sent. AD pwdLastSet 0 / -1 is user data. |
| unknownSchema | omit | attribute types / object classes the target schema does not define, and (non-AD) attributes the record's object classes do not allow, are left out. `send`: predicted errors. Missing MUST and several values of a SINGLE-VALUE type are predicted errors (not adapted). |
| missingReferences (AD) | omit | DN values of entries that do not exist are left out (AD refuses them with 000020B5). Values of entries a *later* record creates are always deferred: added with one modify per entry at the end of the run. `send`: predicted error. |
| existing | skip | add record of an existing entry: `skip` (status "skip"), `update` (missing object classes added, the record's attributes replace the entry's when different, others stay; server-maintained ones never; unchanged → skipped), `fail` (not sent, error). |

Apply-time rules: a record whose entry / parent add failed in this run is not
sent ("not sent: the parent entry X was not created (the add record at line N
failed)"); unicodePwd over a connection without TLS is never sent (predicted
error with explanation). Accounts imported into AD without unicodePwd get a
file-level note (AD exports never contain passwords).

Export: `SortParentFirst` ignores back-links (memberOf made every group/member
pair a cycle, so non-importable AD exports listed groups before members);
`nsRoleDN` (389DS managed-role membership, user data) is no longer stripped by
"Importable".

Lab after the change (`TestLDIFLabRepro`, `…Options`, `…Restore`): OL/DS/slapcat
files without "Importable" import 7/7, 37/37 into OL and DS; DS→OL 37/37 (nsMemberOf
left out); OL "send": entryUUID / createTimestamp / creatorsName stored as in the
source; restore (export, delete, import) of users + group + manager on OL, DS, AD:
4/4 with all members, also with the group first in the file on AD (deferred).
Not adapted (predicted or server error): AD naming rules (`Invalid RDN 'UID' for
inetOrgPerson`), multi-valued mail into AD (predicted), AD userPassword length,
an AD `user` into LDAP loses everything `person` does not allow (named per record).

## 4. Performance (measured before changing anything)

Setup: source = `ldapilot-openldap-perf` (OpenLDAP 2.6, 100,000 users below
`ou=People`; 10,000 = `(employeeNumber=00*)`); target = a throwaway OpenLDAP 2.4.57
(osixia, empty, same base, port 11389), "nosync" = `olcDbNoSync: TRUE` so the server's
fsync does not hide LDAPilot's own cost. Go timings: `services/ldifperf_test.go`
(`go test -tags ldiflab -run TestLDIFPerf`), run against `master` 00c2bb2 (a `git archive`
copy) and this branch. UI timings: the Chrome client of `wails dev` (the bridge is a
WebSocket there, not the native IPC of WebKitGTK). Machine: 8 cores, other agents busy
(load 2–5), single runs, so ±20 %.

### Server baselines
| | 10,000 | 100,000 |
|---|---|---|
| `ldapsearch -E pr=500` `*` `+` (export read) | 0.48 s | 2.43 s |
| `ldapadd -c` (fsync on) | 39.8 s | — |
| `ldapadd -c` (nosync) | 2.93 s | 30.5 s |

### Before (master)
| | 10,000 | 100,000 |
|---|---|---|
| Export, Go (`ExportService.Export`) | 1.62 s (search 1.32 s) | 15.2 s (search 11.3 s) |
| Export text over the bridge | 5.2 MB JSON | 51.6 MB JSON: 21.3 s page → Go → page, then 12.7 s main thread blocked rendering it in the preview `<pre>`, then the same text sent back to `SaveExportFile` |
| Dry run, Go | 3.0 s | 29.8 s |
| Dry run result | 12.6 MB JSON | 126 MB JSON |
| Apply, Go (nosync) | 7.65 s (no userPassword: 4.84 s, + no audit: 4.33 s) | 77.5 s |
| Apply, Go (fsync) | 38.5 s | — |
| Apply result | 5.0 MB JSON | 50.4 MB JSON |

Go profile of the export search: ~70 % of the CPU is go-ldap's BER decoding
(asn1-ber `readPacket`, `AppendChild`), not LDAPilot code.

### Changes
- Export: `ExportService.SaveExport` asks for the file first and writes the export in Go
  (buffered), the text never crosses the bridge; the dialog's preview is the first 200
  entries (`ExportRequest.limit`); an importable export no longer requests `+` (it drops
  every operational attribute anyway): 100,000 entries 15.2 → 9.7 s, byte-identical file.
- Dry run: reads that the planning needs (do the record DNs / parents / new superiors /
  AD DN values exist, AD unique values) are prefetched with 8 parallel requests on the
  connection; DN keys and object class rules are cached per run.
- Large dry runs (> 500 records) keep their records in Go (`GetLDIFPreviewRecords`, newest
  4 runs, 1 h): the dialog gets the first 200 per status and pages through the rest.
- Apply: add records run with up to 8 requests in flight; a record waits for running
  writes of its own DN and its parents, deletes / renames wait for all; sequential on AD
  and when "continue after a failed record" is off.

### The window behind the server: one event per log line

The 100k apply in the dialog (dev client, after the changes above): the server had all
100,000 entries at 03:14, the dialog's progress was at 19,674 then, at 42,282 at 03:15:38
and 59,807 at 03:16:29 (main-thread gaps of 230–500 ms every few hundred ms). Cause: the
backend emits one `operation:log` event per logged operation (ADD and the PWPOLICY
read-back note per record) and one `audit:entry` per audit entry; each `operation:log`
updates the status bar's last operation (shell store) and the Operations view (merges up
to 1,000 rows) — 300,000 events for one file. master behaves the same (the events did not
change), so this is the "slow with many entries" seen in the window.

Fix: `services/event_batch.go` — `operation:log` and `audit:entry` are sent once per 50 ms
with every entry of that interval (`operation:log`: entries…; `audit:entry`: profileId,
entries…); the Operations view merges a batch at once, the status bar takes the last
operation per profile and event.

### After (this branch)
| | 10,000 | 100,000 |
|---|---|---|
| Export, Go | — | 9.7 s straight to the file (byte-identical); preview of the first 200 entries 0.03 s Go / 0.44 s from the page |
| Dry run, Go | 2.4 s | 15.8 s (16 parallel reads instead of 8: no gain) |
| Dry run result | — | 0.25 MB JSON (first 200 per status) |
| Apply, Go (nosync) | 4.4 s | 41.5 s |
| Apply, Go (fsync) | 28.2 s | — |
| Password check before Apply (UI) | — | was 13 s (file sent again + planned again); now 0: the dry run's merged plan answers it, Apply sends no file (`previewRunId`, the backend kept it) |
| Dry run in the dialog (dev build) | — | 33.9 s, main thread blocked once for 1.1 s |
| Apply in the dialog (dev build) | — | before event batching 362 s (server done after ≈ 45 s, then the window caught up with the events, blocked in 0.3–2 s pieces throughout); after 70.8 s, blocked once for 1.3 s (the 50 MB result arriving) |

The dialog numbers are the Chrome client of `wails dev`: its Go binary is a debug build
and the bridge a WebSocket, so the absolute values are higher than in a release build.

## 5. Checked in the running app (2026-11-13, dev client, isolated XDG)

- OpenLDAP: export without "Importable" of `ou=IT,ou=People` re-imported into an own OU:
  dry run names the left-out attributes, 7 / 7 applied; the same file again: 7 skipped.
- 389DS export without "Importable" → OpenLDAP: 37 / 37, `nsMemberOf` and the 389DS
  operational attributes left out; the 36 `{PBKDF2-SHA512}` hashes are kept as sent and
  reported "will not work" (the lab OpenLDAP has no pw-pbkdf2 module; a hash cannot be
  converted) — the dry run said so before.
- OpenLDAP export → 389DS: 7 / 7.
- Samba AD: own users + group + manager exported with every attribute, deleted, file with
  the group first imported: 4 adds + 1 deferred member modify, the group has its 3 members
  again; the note about accounts without passwords is shown.
- Password policy "ask" on a plain-LDAP OpenLDAP profile: one decision dialog for the whole
  file at Apply (client hashing preselected, unencrypted consent), cleartext stored as
  `{CRYPT}$6$`, an existing `{SSHA}` kept (read back with ldapsearch).
- 100,000 records through the dialog (see the table above).

Not checked: a native release build (WebKitGTK IPC); Windows / macOS; AD with the
"send" options; very large AD imports (AD runs sequentially, by design).

## 6. Open / for David

- Defaults chosen: existing entries skipped, unknown attributes / classes and AD
  references to missing entries left out, "continue after a failed record" on.
- `nsRoleDN` is kept by "Importable" exports now (was stripped).
- The apply result of a very large run still crosses the bridge whole (50 MB for 100,000
  records, one 1.3 s block when it arrives); paging it like the dry run is possible.
- Not adapted (predicted or the server's error): AD naming rules (`uid=` RDN for
  inetOrgPerson), several values of a single-valued attribute, AD userPassword length;
  an AD `user` imported into an LDAP server keeps only what `person` allows.
