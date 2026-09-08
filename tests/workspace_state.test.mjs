// Tests for the shell's workspace state (see static/js/workspaceState.js).
//
// The contract this pins down is what the whole restore path leans on:
//   · the synchronous cache answers before the server does, so a widget can
//     apply its mode at page load instead of at panel open;
//   · a record another device wrote BEATS a value migrated from this
//     browser's legacy per-widget keys — migration fills gaps, it never wins;
//   · nothing is recorded until the restore pass arms tracking (otherwise the
//     shell would write "everything is closed" over the state it is about to
//     restore, on every single load);
//   · re-marking an already-open module is a no-op, so the 1s visibility sweep
//     does not turn into a PUT per second against /api/prefs;
//   · the legacy keys survive untouched, so this release can be rolled back.
//
// No DOM and no browser: localStorage and fetch are stubbed before the module
// is imported, because it reads both at import time on purpose.
import assert from 'node:assert/strict';
import test from 'node:test';

const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const puts = [];
const NOW = Date.now();
// What "another device" left on the server: host stats in compact, notes open.
const serverValue = {
  v: 1,
  updatedAt: NOW,
  migrated: true,
  modules: {
    'hoststats-modal': { module: 'hoststats-modal', open: false, minimized: false, mode: 'compact', dock: null, geom: null, openedAt: 0, updatedAt: NOW },
    'notes-panel': { module: 'notes-panel', open: true, minimized: false, mode: null, dock: null, geom: null, openedAt: NOW - 50, updatedAt: NOW },
  },
};

globalThis.fetch = async (url, opts) => {
  if (!opts || !opts.method) {
    // A real round-trip is not instantaneous — the delay is what makes the
    // "cache answers first" assertion meaningful instead of accidental.
    await new Promise((r) => setTimeout(r, 30));
    return { ok: true, json: async () => ({ key: 'workspace-state', value: serverValue }) };
  }
  puts.push(JSON.parse(opts.body).value);
  return { ok: true, json: async () => ({}) };
};

// This browser's legacy keys, from before the shell state existed.
localStorage.setItem('odysseus.hostStats.viewMode.v1', 'full');
localStorage.setItem('odysseus-modal-remembered-dock-gallery-modal', 'right');

const WorkspaceState = (await import('../static/js/workspaceState.js')).default;

test('the synchronous cache answers before the server round-trip lands', () => {
  assert.equal(WorkspaceState.get('hoststats-modal')?.mode, 'full');
});

test('the server copy beats a value migrated from a legacy key', async () => {
  await WorkspaceState.ready();
  assert.equal(WorkspaceState.get('hoststats-modal')?.mode, 'compact');
});

test('a legacy value the server never had IS migrated', () => {
  assert.equal(WorkspaceState.get('gallery-modal')?.dock, 'right');
});

test('a module left open on another device is offered to the restore pass', () => {
  assert.ok(WorkspaceState.openInstances().some((r) => r.id === 'notes-panel'));
});

test('nothing is recorded before tracking is armed', () => {
  assert.equal(WorkspaceState.markOpen('gallery-modal'), false);
  assert.equal(WorkspaceState.get('gallery-modal').open, false);
});

test('open / minimize / close are recorded once armed', () => {
  WorkspaceState.setTrackingArmed(true);
  assert.equal(WorkspaceState.markOpen('gallery-modal'), true);
  assert.equal(WorkspaceState.get('gallery-modal').open, true);

  const openedAt = WorkspaceState.get('gallery-modal').openedAt;
  assert.equal(WorkspaceState.markOpen('gallery-modal'), false, 're-marking must be a no-op');
  assert.equal(WorkspaceState.get('gallery-modal').openedAt, openedAt, 'openedAt must not be re-stamped');

  assert.equal(WorkspaceState.markMinimized('gallery-modal', true), true);
  assert.equal(WorkspaceState.get('gallery-modal').minimized, true);
  assert.equal(WorkspaceState.get('gallery-modal').open, true);

  assert.equal(WorkspaceState.markClosed('gallery-modal'), true);
  assert.equal(WorkspaceState.get('gallery-modal').open, false);
});

test('closing a module that was never open creates no record', () => {
  assert.equal(WorkspaceState.markClosed('never-opened-modal'), false);
  assert.equal(WorkspaceState.get('never-opened-modal'), null);
});

test('a mode change reaches /api/prefs and the cache, and spares the legacy key', async () => {
  WorkspaceState.setMode('hoststats-modal', 'full');
  assert.equal(WorkspaceState.get('hoststats-modal').mode, 'full');

  WorkspaceState.flush();
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(puts.length > 0, 'expected at least one PUT to /api/prefs');
  assert.equal(puts[puts.length - 1].modules['hoststats-modal'].mode, 'full');

  const cached = JSON.parse(localStorage.getItem('odysseus.workspace.v1'));
  assert.equal(cached.modules['hoststats-modal'].mode, 'full');
  assert.equal(localStorage.getItem('odysseus.hostStats.viewMode.v1'), 'full',
    'the legacy key must stay readable so the release can be rolled back');
});
