#!/usr/bin/env bash
# Design token lint gates (SPEC 10.4, CLAUDE.md "Design token rules"): every
# pattern must have 0 matches in frontend/src. Run from anywhere; CI runs it too.
#
#   scripts/lint-tokens.sh
set -euo pipefail
cd "$(dirname "$0")/../frontend/src"

fail=0
gate() {
  local id="$1" what="$2" pattern="$3"
  shift 3
  local hits
  hits="$(grep -rnP --include='*.ts' --include='*.tsx' --include='*.css' "$@" -e "$pattern" . || true)"
  if [ -n "$hits" ]; then
    echo "✗ $id $what"
    echo "$hits" | sed 's/^/    /'
    fail=1
  else
    echo "✓ $id $what"
  fi
}

gate G1  'no text-[8-11px] (use text-xs)'                 'text-\[(8|9|10|11)px\]'
gate G2  'no [#hex] colours'                              '\[#[0-9a-fA-F]{3,8}\]'
gate G3  'no Tailwind palette colours'                    '(text|bg|border|fill)-(red|green|blue|yellow|orange|purple|teal|cyan|amber|indigo|pink)-[0-9]{3}'
gate G4  'no foreground/N text (except /40)'              '(muted-)?foreground/(1|2|3|5|6|7|8)0\b'
gate G5  'no white/N or black/N'                          '\b(white|black)/[0-9]+'
gate G6  'no [Nvw]/[Nvh] sizes'                           '\[\d+v[wh]\]'
gate G7  'no max-w-[Nvw]'                                 'max-w-\[\d+vw\]'
gate G8  'fixed inset-0 only in ui/Dialog.tsx'            'fixed inset-0' --exclude=Dialog.tsx
gate G9  'no confirm( (use ConfirmDialog)'                '(?<!\w)confirm\('
gate G10 '<button has type= on its opening line'          '<button(?![^>\n]*\btype=)(?=[\s>]|$)'
gate G11 'no z-50 / z-100 (use the --z-* scale)'          '\bz-(50|100)\b'
gate G12 'no tinted bg-x/10 text- chips (use <Badge>)'    'bg-[a-z]+(-[a-z]+)?/1[05] text-'

if [ "$fail" -ne 0 ]; then
  echo "Design token lint gates failed (see CLAUDE.md › Design token rules)." >&2
  exit 1
fi
echo "All design token lint gates pass."
