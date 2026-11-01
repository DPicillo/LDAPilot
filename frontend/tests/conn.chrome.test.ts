// Run: cd frontend && node --test 'tests/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELETE_PROGRESS_STALE_MS, ZOOM_PRESETS, countsAsUnread, diagnosticsText, newIssueURL, quitBusyReasons, runningDeleteCount, stepZoom, toastKey, trackDeleteProgress, unreadEntries, versionLine,
} from '../src/components/connection/chromeLogic.ts';

test('Ctrl+= / Ctrl+- step through the zoom presets', () => {
  assert.deepEqual([...ZOOM_PRESETS], [0.8, 0.9, 1, 1.1, 1.25, 1.5]);
  assert.equal(stepZoom(1, 1), 1.1);
  assert.equal(stepZoom(1.1, 1), 1.25);
  assert.equal(stepZoom(1.25, 1), 1.5);
  assert.equal(stepZoom(1.5, 1), 1.5);
  assert.equal(stepZoom(1, -1), 0.9);
  assert.equal(stepZoom(0.8, -1), 0.8);
  // An old off-preset level (120 %) goes to the neighbouring preset.
  assert.equal(stepZoom(1.2, 1), 1.25);
  assert.equal(stepZoom(1.2, -1), 1.1);
  assert.equal(stepZoom(2, -1), 1.5);
  assert.equal(stepZoom(0.5, 1), 0.8);
});

test('identical toasts share a key; only errors and warnings are unread', () => {
  assert.equal(toastKey('info', 'The connection is read-only'), toastKey('info', 'The connection is read-only', undefined));
  assert.notEqual(toastKey('info', 'x'), toastKey('error', 'x'));
  assert.notEqual(toastKey('error', 'x', 'a'), toastKey('error', 'x', 'b'));
  assert.equal(countsAsUnread('success'), false);
  assert.equal(countsAsUnread('info'), false);
  assert.equal(countsAsUnread('error'), true);
  assert.equal(countsAsUnread('warning'), true);
  const h = [
    { type: 'success' as const, timestamp: 30 },
    { type: 'error' as const, timestamp: 20 },
    { type: 'warning' as const, timestamp: 15 },
    { type: 'error' as const, timestamp: 5 },
  ];
  assert.deepEqual(unreadEntries(h, 10).map((e) => e.timestamp), [20, 15]);
});

test('quit guard: what is busy', () => {
  const idle = { batchDialog: false, ldifDialog: false, runningDeletes: 0, dirtyTabs: [] as string[] };
  assert.deepEqual(quitBusyReasons(idle), []);
  const busy = quitBusyReasons({ batchDialog: true, ldifDialog: true, runningDeletes: 2, dirtyTabs: ['anna.fuchs'] });
  assert.equal(busy.length, 4);
  assert.match(busy[0], /2 recursive deletes/);
  assert.match(busy[3], /"anna.fuchs" has unsaved changes/);
  assert.match(quitBusyReasons({ ...idle, dirtyTabs: ['a', 'b'] })[0], /2 tabs have unsaved changes: a, b/);
  let running = new Map<string, number>();
  running = trackDeleteProgress(running, { operationId: 'op1', phase: 'enumerating' }, 1000);
  running = trackDeleteProgress(running, { operationId: 'op1', phase: 'deleting' }, 2000);
  running = trackDeleteProgress(running, { operationId: 'op2', phase: 'deleting' }, 3000);
  assert.equal(runningDeleteCount(running, 4000), 2);
  running = trackDeleteProgress(running, { operationId: 'op1', phase: 'done' }, 5000);
  assert.deepEqual([...running.keys()], ['op2']);
  assert.equal(trackDeleteProgress(running, null, 6000).size, 1);
  // A run that failed before deleting never sends "done": it ends after the stale time.
  assert.equal(runningDeleteCount(running, 3000 + DELETE_PROGRESS_STALE_MS - 1), 1);
  assert.equal(runningDeleteCount(running, 3000 + DELETE_PROGRESS_STALE_MS), 0);
});

test('diagnostics and the prefilled issue', () => {
  const d = {
    version: 'v0.5.0', commit: '9ef4398051b9', buildDate: '2026-10-31T10:00:00Z', modified: true, goVersion: 'go1.26.0', wailsVersion: 'v2.17.0',
    webView: 'libwebkit2gtk-4.1.so.0.16.6', userAgent: 'AppleWebKit/605.1.15', os: 'linux (Debian 13)', arch: 'amd64', configDir: '/home/x/.config/LDAPilot', serverType: 'openldap',
  };
  assert.equal(versionLine(d), 'v0.5.0 (9ef4398051b9, 2026-10-31, modified)');
  // RW1-C-04: an unstamped build says so.
  assert.equal(versionLine({ version: '' }), 'development build');
  assert.equal(versionLine({ version: 'dev', commit: 'abc1234' }), 'development build (abc1234)');
  assert.equal(versionLine({ version: 'v0.5.0-dev' }), 'v0.5.0 development build');
  const text = diagnosticsText(d);
  assert.match(text, /^LDAPilot v0\.5\.0/);
  assert.match(text, /Wails: v2\.17\.0/);
  assert.match(text, /Web view: libwebkit2gtk-4\.1\.so\.0\.16\.6 · AppleWebKit/);
  assert.match(text, /Active server: OpenLDAP/);
  // RW1-C-11: no OS user name in a public issue.
  assert.match(text, /Config: ~\/\.config\/LDAPilot/);
  assert.doesNotMatch(text, /\/home\/x/);
  assert.match(diagnosticsText({ version: 'dev', serverType: null }), /Active server: none/);
  const url = newIssueURL('https://github.com/DPicillo/LDAPilot/issues/', d);
  assert.ok(url.startsWith('https://github.com/DPicillo/LDAPilot/issues/new?body='));
  assert.match(decodeURIComponent(url.split('body=')[1]), /OS: linux \(Debian 13\) amd64/);
});
