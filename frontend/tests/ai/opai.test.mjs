// op-ai package: DN links with doubled escapes (P3), docked chat width (N2),
// Ask AI wording and the "@" list (S4). node --test 'tests/ai/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dnCanonKey, isAnswerDN, isStrictDN, resolveAnswerDN, undoubleEscapes } from '../../src/lib/aiFormat.ts';
import { EDITOR_MIN_DOCKED, fitDockedPanes, needsRefit } from '../../src/lib/aiDock.ts';
import { askAITitleText, dropBareAt } from '../../src/lib/aiComposer.ts';

const SPECIAL = 'OU=Special Cases,OU=LDAPilot,DC=ad,DC=ldapilot,DC=lab';
// The DNs as the tool results (and the server) write them.
const SEMI = `CN=Semi\\3BColon \\<Angle\\>,${SPECIAL}`;
const HASH = `CN=\\#Hash User,${SPECIAL}`;
const BACK = `CN=Back\\\\Slash,${SPECIAL}`;
const QUOTE = `CN=Quote \\"Q\\" User,${SPECIAL}`;
const COMMA = `CN=Schmidt\\, Anna,${SPECIAL}`;
const known = [SEMI, HASH, BACK, QUOTE, COMMA, `CN=Anna Schmidt,OU=Users,${SPECIAL}`];
const index = Object.fromEntries(known.map((d) => [dnCanonKey(d), d]));
const lookup = (k) => index[k];
const none = () => undefined;

test('dnCanonKey ignores case and how a value is escaped', () => {
  assert.equal(dnCanonKey('CN=Semi\\3BColon,DC=x'), dnCanonKey('cn=semi\\;colon, dc=X'));
  assert.equal(dnCanonKey('CN=a\\2Cb,DC=x'), dnCanonKey('CN=a\\,b,DC=x'));
  assert.equal(dnCanonKey('CN=J\\C3\\BCrgen,DC=x'), dnCanonKey('CN=Jürgen,DC=x'));
  assert.equal(dnCanonKey('CN=a+UID=b,DC=x'), dnCanonKey('uid=b+cn=A,dc=x'));
  assert.notEqual(dnCanonKey('CN=a\\,b,DC=x'), dnCanonKey('CN=a,CN=b,DC=x'));
  // an escaped trailing space is part of the value
  assert.notEqual(dnCanonKey('CN=a\\ ,DC=x'), dnCanonKey('CN=a,DC=x'));
  assert.equal(dnCanonKey('not a dn'), null);
});

test('strict DNs: every backslash escapes something, no bare <>";', () => {
  assert.equal(isStrictDN(SEMI), true);
  assert.equal(isStrictDN(HASH), true);
  assert.equal(isStrictDN(BACK), true);
  assert.equal(isStrictDN(`CN=Semi\\3BColon \\\\<Angle\\\\>,${SPECIAL}`), false); // doubled: bare "<"
  assert.equal(isStrictDN(`CN=Back\\Slash,${SPECIAL}`), false); // "\S" is no escape
  assert.equal(undoubleEscapes('CN=a\\\\<b\\\\>,DC=x'), 'CN=a\\<b\\>,DC=x');
  // JSON escaping: \\ → \ and \" → " (only in text with a doubled backslash)
  assert.equal(undoubleEscapes('CN=Quote \\\\\\"Q\\\\\\" User,DC=x'), 'CN=Quote \\"Q\\" User,DC=x');
  assert.equal(undoubleEscapes('CN=Quote \\"Q\\" User,DC=x'), 'CN=Quote \\"Q\\" User,DC=x');
  // a doubled escape before a comma would split the DN: still a link
  assert.equal(isAnswerDN('CN=Schmidt\\\\, Anna,OU=x,DC=y'), true);
  assert.equal(isAnswerDN('no dn here'), false);
});

test('a DN with doubled escapes opens the DN of the tool result (P3, A-21)', () => {
  // What qwen3-vl:8b wrote in the final check and the re-walk:
  assert.equal(resolveAnswerDN(`CN=Semi\\3BColon \\\\<Angle\\\\>,${SPECIAL}`, lookup), SEMI);
  assert.equal(resolveAnswerDN(`CN=Semi\\\\3BColon \\\\<Angle\\\\>,${SPECIAL}`, lookup), SEMI);
  assert.equal(resolveAnswerDN(`CN=\\\\#Hash User,${SPECIAL}`, lookup), HASH);
  assert.equal(resolveAnswerDN(`CN=Back\\\\\\\\Slash,${SPECIAL}`, lookup), BACK);
  // the final re-walk: a JSON-escaped quote and comma
  assert.equal(resolveAnswerDN(`CN=Quote \\\\\\"Q\\\\\\" User,${SPECIAL}`, lookup), QUOTE);
  assert.equal(resolveAnswerDN(`CN=Schmidt\\\\, Anna,${SPECIAL}`, lookup), COMMA);
  // case and another escape form of the same value
  assert.equal(resolveAnswerDN(`cn=semi\\;colon \\<angle\\>,${SPECIAL.toLowerCase()}`, lookup), SEMI);
  // correct DNs stay as the tool wrote them
  assert.equal(resolveAnswerDN(BACK, lookup), BACK);
  assert.equal(resolveAnswerDN('⁠' + HASH, lookup), HASH);
});

test('without a tool result the doubled escapes are collapsed when that gives a valid DN', () => {
  assert.equal(resolveAnswerDN(`CN=Semi\\3BColon \\\\<Angle\\\\>,${SPECIAL}`, none), SEMI);
  assert.equal(resolveAnswerDN(`CN=Back\\\\\\\\Slash,${SPECIAL}`, none), BACK);
  assert.equal(resolveAnswerDN(`CN=\\\\#Hash User,${SPECIAL}`, none), HASH);
  assert.equal(resolveAnswerDN(`CN=Quote \\\\\\"Q\\\\\\" User,${SPECIAL}`, none), QUOTE);
  assert.equal(resolveAnswerDN(`CN=Schmidt\\\\, Anna,${SPECIAL}`, none), COMMA);
  assert.equal(resolveAnswerDN(QUOTE, none), QUOTE);
  // a correct backslash value is not "repaired"
  assert.equal(resolveAnswerDN(BACK, none), BACK);
  assert.equal(resolveAnswerDN('CN=Plain,DC=x', none), 'CN=Plain,DC=x');
});

test('the docked chat leaves the editor column its minimum (N2)', () => {
  const base = { sidebarMin: 220, aiMin: 300, editorMin: EDITOR_MIN_DOCKED };
  // 1100 px window − 48 px activity bar: AI pane first, then the side bar
  assert.deepEqual(fitDockedPanes({ ...base, total: 1052, sidebar: 280, ai: 380 }), { sidebar: 220, ai: 300, editor: 532 });
  // enough room: the saved widths
  assert.deepEqual(fitDockedPanes({ ...base, total: 1452, sidebar: 280, ai: 380 }), { sidebar: 280, ai: 380, editor: 792 });
  // only the AI pane needs to give way
  assert.deepEqual(fitDockedPanes({ ...base, total: 1200, sidebar: 280, ai: 380 }), { sidebar: 280, ai: 360, editor: 560 });
  // side bar hidden
  assert.deepEqual(fitDockedPanes({ ...base, total: 800, sidebar: 0, ai: 380 }), { sidebar: 0, ai: 300, editor: 500 });
  // undocked: the side bar gets its saved width back
  assert.deepEqual(fitDockedPanes({ total: 1052, sidebar: 280, sidebarMin: 220, ai: 0, aiMin: 0, editorMin: 0 }), { sidebar: 280, ai: 0, editor: 772 });
  assert.equal(needsRefit({ sidebar: 280, ai: 380 }, { sidebar: 280, ai: 381, editor: 0 }), false);
  assert.equal(needsRefit({ sidebar: 280, ai: 380 }, { sidebar: 220, ai: 300, editor: 0 }), true);
});

test('Ask AI titles: first 5 of n, these n, this <kind>', () => {
  assert.equal(askAITitleText(22, 'Entry', 5, false), 'Ask AI about the First 5 of 22 Entries');
  assert.equal(askAITitleText(6, 'Entry', 5, false), 'Ask AI about the First 5 of 6 Entries');
  assert.equal(askAITitleText(5, 'Entry', 5, false), 'Ask AI about These 5 Entries');
  assert.equal(askAITitleText(1, 'organizational unit', 5, false), 'Ask AI about This Organizational Unit');
  assert.equal(askAITitleText(1, 'user', 5, true), 'Ask AI about This User (no AI access)');
});

test('Esc in the @ list removes a bare "@" (S4)', () => {
  assert.deepEqual(dropBareAt('who is @', 8), { text: 'who is', caret: 6 });
  assert.deepEqual(dropBareAt('@', 1), { text: '', caret: 0 });
  assert.deepEqual(dropBareAt('a @ b', 3), { text: 'a b', caret: 1 });
  assert.equal(dropBareAt('who is @ann', 11), null);
  assert.equal(dropBareAt('mail me@x', 9), null);
});
