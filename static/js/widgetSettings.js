// static/js/widgetSettings.js
//
// WidgetSettings — per-USER, server-backed knob store for the shell's widgets.
//
// Why this exists (roadmap #29, "widget-settings server-side por-usuario"): a
// widget's tunables (host-stats' refresh interval, bar resolution, tone
// thresholds…) were hardcoded consts. To make them user-configurable from the
// axon Settings panel they need a home that (a) survives a signout — both
// logout (settings.js) and the user-switch guard (init.js) wipe localStorage on
// the way out — and (b) follows the user across devices. That is exactly what
// workspaceState.js already solved for shell layout, so this is its SIBLING:
// the same cache-first / server-of-record / debounced-PUT machinery, aimed at
// /api/prefs/widget-settings instead of /api/prefs/workspace-state.
//
// GENERIC ON PURPOSE. Host-stats is the FIRST widget to use it, but nothing
// here knows about host-stats: the value is a map keyed by widget id, and each
// widget registers its own knob specs (ranges) with defineWidget(). Tiling and
// the switcher drop in the same way, without touching this file.
//
// WHERE IT LIVES: the server, under /api/prefs/widget-settings — per USER, not
// per browser (see workspaceState.js for the full rationale). localStorage
// stays as an OPTIMISTIC CACHE so the first read at page load is synchronous
// (a widget can pick its refresh interval before the network answers) and so
// the shell degrades honestly when the prefs endpoint is unreachable.
//
// SHAPE (v1):
//   {
//     v: 1,
//     updatedAt: <ms>,
//     widgets: {
//       "<widgetId>": {           // e.g. "hoststats"
//         <knobKey>: <value>,     // e.g. refreshMs: 1500
//         ...,
//         updatedAt: <ms>         // per-record, for LWW merges
//       }
//     }
//   }
//
// MERGE: per-WIDGET last-write-wins on the record's `updatedAt`, mirroring
// workspaceState's per-record merge. A widget record is cohesive (its knobs are
// edited together on one device); two devices racing DIFFERENT knobs of the
// same widget is the accepted trade-off of this granularity, same as the shell
// state. Records are never deleted, so there are no tombstone races.
//
// CLAMP: set() coerces a numeric knob to its registered range (clamp, not
// reject — a slider that hits the rail should stick at the rail, not silently
// no-op). A non-finite value, or one for a widget/knob with no spec that is
// non-numeric, is stored as-is (generic pass-through) or ignored if unusable.
// Nothing here throws: a bad value must never take the widget down.

const PREF_KEY = 'widget-settings';            // /api/prefs/<key>
const CACHE_KEY = 'odysseus.widgetSettings.v1'; // optimistic per-browser cache
const SCHEMA_V = 1;
const FLUSH_MS = 800;                           // debounce before hitting prefs

const _empty = () => ({ v: SCHEMA_V, updatedAt: 0, widgets: {} });

let _state = _empty();
let _dirty = false;
let _flushTimer = null;
let _serverReachable = true;
const _subs = new Set();
const _specs = new Map();       // widgetId -> { knobKey: { min, max, step, int } }

let _resolveReady;
const _readyPromise = new Promise((r) => { _resolveReady = r; });

// ── plumbing ──────────────────────────────────────────────────────────────

function _now() { return Date.now(); }

function _sane(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.v !== SCHEMA_V) return null;           // future/old schema: ignore
  if (!raw.widgets || typeof raw.widgets !== 'object') return null;
  return raw;
}

function _readCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return _sane(raw);
  } catch (_) { return null; }
}

function _writeCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(_state)); } catch (_) {}
}

/** Per-record (per-widget) last-write-wins. Neither side is authoritative: the
 *  server holds what other devices wrote, the cache holds writes this browser
 *  may not have flushed yet (a tab closed mid-debounce). */
function _merge(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = {
    v: SCHEMA_V,
    updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
    widgets: {},
  };
  const ids = new Set([...Object.keys(a.widgets || {}), ...Object.keys(b.widgets || {})]);
  for (const id of ids) {
    const ra = a.widgets[id];
    const rb = b.widgets[id];
    if (!ra) { out.widgets[id] = rb; continue; }
    if (!rb) { out.widgets[id] = ra; continue; }
    out.widgets[id] = (rb.updatedAt || 0) > (ra.updatedAt || 0) ? rb : ra;
  }
  return out;
}

async function _fetchServer() {
  try {
    const res = await fetch(`/api/prefs/${PREF_KEY}`, { credentials: 'same-origin' });
    if (!res.ok) { _serverReachable = false; return null; }
    const body = await res.json().catch(() => null);
    return _sane(body && body.value);
  } catch (_) {
    _serverReachable = false;
    return null;
  }
}

function _pushServer(keepalive) {
  const payload = JSON.stringify({ value: _state });
  try {
    return fetch(`/api/prefs/${PREF_KEY}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: !!keepalive,     // survives the pagehide that carries the last write
    }).then((res) => { _serverReachable = res.ok; }).catch(() => { _serverReachable = false; });
  } catch (_) {
    _serverReachable = false;
    return Promise.resolve();
  }
}

function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    if (!_dirty) return;
    _dirty = false;
    _pushServer(false);
  }, FLUSH_MS);
}

/** Flush now (page is going away). Called from pagehide/visibilitychange. */
export function flush() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (!_dirty) return;
  _dirty = false;
  _pushServer(true);
}

function _notify(widgetId, knobKey) {
  for (const fn of _subs) {
    try { fn(widgetId, knobKey); } catch (e) { console.warn('[widgetSettings] subscriber failed:', e); }
  }
}

// ── validation / clamp ─────────────────────────────────────────────────────
//
// A knob's spec is whatever defineWidget() registered for it: { min, max,
// step, int }. Only min/max/int are consulted here — label/help and anything
// else the caller stashed alongside are ignored, so a widget can keep its UI
// metadata in the SAME table it registers (one source of truth).

function _specOf(widgetId, knobKey) {
  const s = _specs.get(widgetId);
  return (s && s[knobKey]) || null;
}

/** Coerce+clamp a value against its knob spec. Returns the value to store, or
 *  undefined when the value is unusable (⇒ set() ignores it). No spec ⇒ the
 *  value passes through untouched (generic store). */
function _coerce(widgetId, knobKey, value) {
  const spec = _specOf(widgetId, knobKey);
  if (!spec) return value;                       // generic: no range to enforce
  let n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;     // NaN / '' / null: ignore
  if (spec.int) n = Math.round(n);
  if (Number.isFinite(spec.min)) n = Math.max(spec.min, n);
  if (Number.isFinite(spec.max)) n = Math.min(spec.max, n);
  return n;
}

function _write(widgetId, knobKey, value) {
  if (!widgetId || !knobKey) return false;
  const v = _coerce(widgetId, knobKey, value);
  if (v === undefined) return false;             // unusable value: never throws, never writes
  const prev = _state.widgets[widgetId] || null;
  if (prev && JSON.stringify(prev[knobKey]) === JSON.stringify(v)) return false; // no-op
  const rec = { ...(prev || {}), [knobKey]: v, updatedAt: _now() };
  _state.widgets[widgetId] = rec;
  _state.updatedAt = Math.max(_state.updatedAt || 0, rec.updatedAt);
  _dirty = true;
  _writeCache();
  _scheduleFlush();
  _notify(widgetId, knobKey);
  return true;
}

// ── boot ────────────────────────────────────────────────────────────────────
//
// Two phases, same as workspaceState: the cache is read SYNCHRONOUSLY at
// module-eval time so a widget asking "what's my refresh interval?" gets an
// answer without waiting for the network; the server read lands later and
// reconciles (carrying values from another device, or back from a signout that
// wiped this browser).

const _cached = _readCache();
if (_cached) _state = _cached;

(async () => {
  const server = await _fetchServer();
  if (server) _state = _merge(_state, server);
  _writeCache();
  _resolveReady(_state);
})();

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
}

// ── public API ────────────────────────────────────────────────────────────

/**
 * Register a widget's knob specs so set() can clamp them. `specs` is a map
 * knobKey -> { min, max, step, int, ... }; extra fields (label/help) are kept
 * by the caller and ignored here. Safe to call repeatedly (last one wins).
 */
export function defineWidget(widgetId, specs) {
  if (widgetId && specs && typeof specs === 'object') _specs.set(widgetId, specs);
}

/** Resolves once the server state has been merged in (or has failed). */
export function ready() { return _readyPromise; }

/** Whether the last server round-trip worked. False ⇒ cache-only degraded mode. */
export function isServerReachable() { return _serverReachable; }

/** Synchronous read of one knob; `fallback` when unset. Serves the cache
 *  before ready() resolves. */
export function get(widgetId, knobKey, fallback) {
  const rec = _state.widgets[widgetId];
  const v = rec ? rec[knobKey] : undefined;
  return v === undefined ? fallback : v;
}

/** Every stored knob of one widget, cloned (without the internal `updatedAt`).
 *  Empty object when the widget has nothing stored yet. */
export function getAll(widgetId) {
  const rec = _state.widgets[widgetId];
  if (!rec) return {};
  const out = { ...rec };
  delete out.updatedAt;
  return out;
}

/** Write one knob. Coerced/clamped against its registered spec; a no-op or an
 *  unusable value returns false and writes nothing. Never throws. */
export function set(widgetId, knobKey, value) {
  return _write(widgetId, knobKey, value);
}

/** Subscribe to writes. fn(widgetId, knobKey) fires after each accepted set. */
export function subscribe(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

const WidgetSettings = {
  defineWidget, ready, isServerReachable, get, getAll, set, subscribe, flush,
};

export default WidgetSettings;
