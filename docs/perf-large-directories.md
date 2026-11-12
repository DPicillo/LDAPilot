# Performance with large directories: measurements and findings

Branch `DPicillo/perf-large-directories`, November 2026. The reported case: an OpenLDAP with
40,000 groups directly below one node at the top of the tree "takes forever to load"; scrolling
the tree against AD is "not perfect either".

## Result (production build, native WebKitGTK window)

| What | Before (master 672122b) | After |
|---|---|---|
| "Open list" on 40,000 groups: first rows | **101 s** (one block of the main thread) | **1.0 s** |
| … usable (attribute columns there, no long task for 1.5 s) | 150 s | 3.4 s |
| … main thread blocked in total | 149 s | 0.7 s (longest 0.46 s) |
| AD tree (lab Samba, 30 OUs expanded, OU=Bulk shown in full), scroll 66 px per frame | 45 fps, React 5.9 ms per frame | 50 fps, React 2.2 ms per frame |
| … scroll 220 px per frame (≈ a wheel step) | 36 fps, React 7.1 ms | 43 fps, React 3.6 ms |
| … scroll 2,000 px per frame (every row new) | 14 fps, React 14.7 ms | 14 fps, React 14.7 ms |
| Tree with 40,001 rows ("Show all"), scroll 66 px per frame | 44 fps (after the "Open list" fixes, before the row memo) | 50 fps, React 2.3 ms |
| Contents list (40,001 rows), scroll 88 px per frame | 17 – 22 fps | 21 fps, React 11 ms |

The same scroll on a static copy of the DOM (no React) runs at 60 fps for the tree and 36 fps
for the Contents list: what is left in the tree is mostly the browser's work for new rows; the
list's table costs ≈ 29 ms per frame in layout and paint by itself (open item, see the end).

## Setup

- Server: `ldapilot-openldap-perf` (docker compose profile `perf`, ports 10389 / 10636, see
  `docker/README.md`), OpenLDAP 2.6.10, base `dc=perf,dc=ldapilot,dc=lab`, bulk load 45 s,
  853 MB: `ou=Groups` 40,000 groupOfNames directly below, `ou=People` 100,000 inetOrgPerson
  directly below, `ou=Departments` with the other 60,000 groups, `ou=Sites` 800 OUs,
  `ou=Contacts` 2,000 contacts.
- The reported case: a profile with base DN `ou=Groups,dc=perf,dc=ldapilot,dc=lab`; the tree
  root then has the 40,000 children ("40,000 entries · Open list").
- Backend timings: `go test -tags perflab -run TestPerfLab -v ./internal/ldap`
  (`internal/ldap/perflab_test.go`, median of `PERFLAB_RUNS`).
- UI timings: a temporary harness (not committed) that ran inside the app — in the Chrome
  client of `wails dev` and in the native window of production builds
  (`VITE_PERF_AUTORUN=1 wails build -tags webkit2_41`, isolated XDG directories) — clicking
  "Open list", expanding the AD tree and scrolling by a fixed step per `requestAnimationFrame`;
  blocking = gaps of a 16 ms timer (WebKit has no Long Tasks API), React time = `<Profiler>`
  of React's profiling build.
- Machine: 8 cores, 30 GB; other agents ran builds and tests at the same time (load average up
  to 11), so single numbers vary by up to a factor of 2.
- Chrome traces of *scrolling* in the development build are useless: ≈ 75 % of the time is
  `console.createTask` / async stack capture of the attached debugger. Scroll numbers above are
  production builds in the native window.

## Backend

| What | 40,000 groups | 100,000 users |
|---|---|---|
| `ldapsearch` one-level, paged 500, same attributes | 0.7 – 0.9 s | 2.5 – 2.7 s |
| slapd's own time (sum of `etime`) | ≈ 1.0 s | ≈ 2.9 s |
| Go: the paged search alone | 1.1 – 1.4 s | 3.3 – 3.9 s |
| Go: `Client.GetChildren` | 1.3 – 1.5 s | 7.3 – 7.5 s |
| Result as the Wails bridge sends it | 8.6 MB JSON, 120 – 180 ms to encode | 26.9 MB JSON, 0.4 – 0.9 s |
| Raw binding call from the page (`GetChildren`, browser client) | 2.1 s | — |

- The backend was never the "forever": 40,000 groups are listed in ≈ 1.4 s.
- Page size (500 / 1000 / 5000 / unpaged) makes no measurable difference on this server.
- For 100,000 users `GetChildren` makes two full passes: the listing and `fillLoginAttributes`
  (types-only `(objectClass=person)` for the contact detection), about half of the 7.3 s.
  Not changed (open item).
- The Go CPU profile is half BER decoding and garbage collection (go-ldap / asn1-ber); nothing
  in LDAPilot's own code stands out.

## Root causes in the UI and the changes

Measured on "Open list" (the entry editor's Contents sub-tab; a container selected in the tree
opens the same view).

1. **Breadcrumb root, quadratic** (the 101 s block). On every opening of an entry, `EntryEditor`
   computes the first breadcrumb with `owningTreeRoot`, which asked `isNamingContextHead` for every
   node below the tree roots — the 40,000 preloaded children — and `isNamingContextHead` walked
   all nodes again (`forestDomain`): 1.6 billion node visits. CPU profile: 64.7 of 67 s.
   Change: `owningTreeRoot` follows only the ancestor chain of the entry (exact DN first, the
   normalized comparison only as a fallback); the forest domains are collected once per roots
   array (`lib/treesearch.ts` `forestDomainKeys`, used by `isNamingContextHead`).
2. **Table sort**: `DataTable` derived both rows' sort values in each of the ≈ 520,000 comparisons
   and compared with `localeCompare` and options (a collator per call). 10,000 rows took 15 s.
   Change: `components/ui/tableSort.ts` `sortRowsBy`: each value once, one shared `Intl.Collator`,
   same order as before (stable, empty values last, dates by time, natural text order). The list
   still sorts twice (rows, then rows with the attribute columns): ≈ 0.36 s each in the
   development build.
3. **Names**: `unescapeDNValue` encoded every character with a new `TextEncoder` (36 – 100 µs per
   RDN value, for every name shown or sorted). Change: values without `\` are returned as they are,
   encoder and decoder are shared, plain runs are encoded at once (same results; test compares with
   the old implementation).
4. **Account status cache**: `cachedAccountStatus` normalized the DN of every row even with an empty
   cache; it now returns at once then.
5. **Scrolling re-rendered everything**: each scroll event re-rendered every rendered row of the
   `DataTable` (≈ 55 rows × cells) and of the tree (rows got new callbacks each render).
   Changes: `DataTable` renders its rows through a memoized `DataRow` (handlers read through a ref;
   a row renders again when its props change or the parent renders the table: `epoch` = the
   table's props object, so cells that read outside state stay current); `TreeNodeRow` is memoized
   (`sameRowProps`) and takes one stable `TreeRowActions` object from `DirectoryTree` (kept current
   through a ref). React time per scroll frame in the AD tree: 5.9 → 2.2 ms.

Development-build steps in the Chrome client ("Open list", 40,000 groups):

| Step | First rows | Usable | Blocked |
|---|---|---|---|
| Before | ≈ 230 s | ≈ 255 s | 250 s (79 + 90 + 81 s) |
| `unescapeDNValue` | 87 s | 107 s | 106 s |
| + table sort | 65 s | 69 s | 67 s (one block of 64 s: cause 1) |
| + breadcrumb root | 1.3 s | 4.9 s | 3.3 s |

Requested by David during the work: the tree's default sort is now **Type, then name**
(`treePrefs.DEFAULT_SORT_MODE`; a stored choice is kept; the Contents list follows the tree).

## Open items

- **Contents list scrolling** (≈ 21 fps at 88 px per frame): a static copy of the table already
  needs ≈ 29 ms per frame in WebKitGTK (layout / paint of the `<table>` with sticky header and
  spacer rows), plus ≈ 11 ms React. Candidates: a div-based grid with absolutely positioned rows
  like the tree, `contain` on the scroll body, fewer elements per cell (the checkbox renders two
  icons), a smaller overscan.
- **Fast scrolling** (2,000 px per frame, every row new): 14 fps in the tree, 9 fps in the list,
  dominated by creating the rows' DOM; a smaller overscan (tree 20, table 12) would help a little.
- **100,000 children**: `GetChildren` reads the container twice (listing + types-only contact
  check, ≈ 3.5 s of 7.3 s); asking only persons without `uid` in the second pass
  (`(&(objectClass=person)(!(uid=*)))`) would skip it for ordinary user containers. The bridge
  carries 27 MB JSON for the tree plus the Contents list's own one-level search with 28
  attributes.
- The Contents list sorts its 40,000 rows twice (before and after the attribute columns arrive).
