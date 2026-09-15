// Tests for the shell's per-user widget knob store (see
// static/js/widgetSettings.js).
//
// The contract this pins down mirrors what workspaceState already proved, plus
// the one thing this store adds — range clamping:
//   · the synchronous cache answers before the server round-trip lands, so a
//     widget can pick its refresh interval at page load, not at panel open;
//   · per-WIDGET last-write-wins: a widget record another device wrote with a
//     newer updatedAt beats the cached one, and a widget only one side has
//     survives the merge untouched;
//   · set() coerces+clamps a numeric knob to its registered range (a value past
//     the rail sticks at the rail); a non-finite value is ignored and never
//     throws;
//   · get() falls back to the caller's default for an unset knob, getAll()
//     returns the stored knobs without the internal bookkeeping field;
//   · a write reaches /api/prefs as a v1-shaped payload and the cache.
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
const OLD = NOW - 100000;

// What "another device" left on the server: host-stats' refresh bumped to 5000
// (newer than the cache's 3000), plus a tiling widget this browser never saw.
const serverValue = {
  v: 1,
  updatedAt: NOW,
  widgets: {
    hoststats: { refreshMs: 5000, segments: 24, updatedAt: NOW },
    tiling: { gap: 8, updatedAt: NOW },
  },
};

globalThis.fetch = async (url, opts) => {
  if (!opts || !opts.method) {
    // A real round-trip is not instantaneous — the delay is what makes the
    // "cache answers first" assertion meaningful instead of accidental.
    await new Promise((r) => setTimeout(r, 30));
    return { ok: true, json: async () => ({ key: 'widget-settings', value: serverValue }) };
  }
  puts.push(JSON.parse(opts.body).value);
  return { ok: true, json: async () => ({}) };
};

// This browser's optimistic cache, from before the server answered: host-stats
// at an OLDER refresh, plus a switcher widget only this browser has.
localStorage.setItem('odysseus.widgetSettings.v1', JSON.stringify({
  v: 1,
  updatedAt: OLD,
  widgets: {
    hoststats: { refreshMs: 3000, updatedAt: OLD },
    switcher: { foo: 7, updatedAt: OLD },
  },
}));

const WidgetSettings = (await import('../static/js/widgetSettings.js')).default;

// Register host-stats' ranges so set() has something to clamp against (the real
// widget does this from hostStats.js's HOSTSTATS_KNOBS at load time).
WidgetSettings.defineWidget('hoststats', {
  refreshMs: { min: 500, max: 10000, step: 100, int: true },
  segments: { min: 8, max: 48, step: 1, int: true },
  hotPct: { min: 50, max: 100, step: 1, int: true },
});

test('the synchronous cache answers before the server round-trip lands', () => {
  assert.equal(WidgetSettings.get('hoststats', 'refreshMs', 1500), 3000);
});

test('a widget record the server wrote newer beats the cached one', async () => {
  await WidgetSettings.ready();
  assert.equal(WidgetSettings.get('hoststats', 'refreshMs', 1500), 5000);
  assert.equal(WidgetSettings.get('hoststats', 'segments', 24), 24);
});

test('a widget only the cache had survives the merge', () => {
  assert.equal(WidgetSettings.get('switcher', 'foo'), 7);
});

test('a widget only the server had is present after the merge', () => {
  assert.equal(WidgetSettings.get('tiling', 'gap'), 8);
});

test('get falls back to the caller default for an unset knob', () => {
  assert.equal(WidgetSettings.get('hoststats', 'doesNotExist', 42), 42);
  assert.equal(WidgetSettings.get('no-such-widget', 'x', 'dflt'), 'dflt');
});

test('set clamps a value above the range to the max', () => {
  assert.equal(WidgetSettings.set('hoststats', 'refreshMs', 999999), true);
  assert.equal(WidgetSettings.get('hoststats', 'refreshMs'), 10000);
});

test('set clamps a value below the range to the min', () => {
  assert.equal(WidgetSettings.set('hoststats', 'segments', 3), true);
  assert.equal(WidgetSettings.get('hoststats', 'segments'), 8);
});

test('set rounds an integer knob', () => {
  WidgetSettings.set('hoststats', 'hotPct', 90.6);
  assert.equal(WidgetSettings.get('hoststats', 'hotPct'), 91);
});

test('set coerces a numeric string against the spec', () => {
  WidgetSettings.set('hoststats', 'refreshMs', '2500');
  assert.equal(WidgetSettings.get('hoststats', 'refreshMs'), 2500);
});

test('set ignores a non-finite value and does not throw', () => {
  const before = WidgetSettings.get('hoststats', 'refreshMs');
  assert.equal(WidgetSettings.set('hoststats', 'refreshMs', 'not-a-number'), false);
  assert.equal(WidgetSettings.get('hoststats', 'refreshMs'), before);
});

test('set is a no-op when the value is unchanged', () => {
  const v = WidgetSettings.get('hoststats', 'segments');
  assert.equal(WidgetSettings.set('hoststats', 'segments', v), false);
});

test('a knob with no registered spec passes through untouched', () => {
  assert.equal(WidgetSettings.set('tiling', 'gap', 40), true);
  assert.equal(WidgetSettings.get('tiling', 'gap'), 40);
});

test('getAll returns the stored knobs without the bookkeeping field', () => {
  const all = WidgetSettings.getAll('hoststats');
  assert.equal(all.refreshMs, 2500);
  assert.equal(all.segments, 8);
  assert.ok(!('updatedAt' in all), 'updatedAt must not leak out of getAll');
  assert.deepEqual(WidgetSettings.getAll('no-such-widget'), {});
});

test('a write reaches /api/prefs as a v1-shaped payload and the cache', async () => {
  WidgetSettings.set('hoststats', 'hotPct', 88);
  WidgetSettings.flush();
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(puts.length > 0, 'expected at least one PUT to /api/prefs');
  const last = puts[puts.length - 1];
  assert.equal(last.v, 1, 'payload must be v1-shaped');
  assert.equal(last.widgets.hoststats.hotPct, 88);

  const cached = JSON.parse(localStorage.getItem('odysseus.widgetSettings.v1'));
  assert.equal(cached.v, 1);
  assert.equal(cached.widgets.hoststats.hotPct, 88);
});
