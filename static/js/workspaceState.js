// static/js/workspaceState.js
//
// WorkspaceState — THE shell state. One store that knows which modules are
// open, in which instance, and in which mode (full/compact); everything the
// shell paints is DERIVED from it.
//
// Why this exists (roadmap #29): the workspace had no state model. Each widget
// persisted its own slice under its own localStorage key — the host-stats view
// mode (`odysseus.hostStats.viewMode.v1`), the remembered dock side per modal
// (`odysseus-modal-remembered-dock-<id>`), the minimized-chip dock
// (`odysseus.mobileDockState.v1`), per-window sizes (windowResize.js's
// `storageKey`) — and NOTHING knew "what is open and where". So a reload lost
// the workspace, and every new feature (tiling, rail-as-projection, reserved
// edge regions) would have had to invent its own eighth key. This is the
// foundation those consume, not an eighth key.
//
// WHERE IT LIVES: the server, under /api/prefs/workspace-state — per USER,
// not per browser. That is forced by the requirement itself: the workspace must
// survive signout/signin, and both logout (settings.js) and the user-switch
// guard (init.js) deliberately WIPE localStorage on the way out. Anything kept
// only in localStorage is erased by design at exactly the moment it would need
// to be restored. localStorage stays as an OPTIMISTIC CACHE so the first paint
// after a reload is synchronous and so the shell still works offline / when the
// prefs endpoint is unreachable.
//
// SHAPE (v1):
//   {
//     v: 1,
//     updatedAt: <ms>,
//     migrated: <bool>,          // legacy per-widget keys already folded in
//     modules: {
//       "<instanceId>": {
//         module:    "hoststats-modal",   // WHAT it is (type)
//         open:      true,
//         minimized: false,
//         mode:      "full" | "compact" | null,
//         dock:      "left" | "right" | null,
//         geom:      { x, y, w, h } | null,   // reserved — see below
//         openedAt:  <ms>,                     // restore order (z-order proxy)
//         updatedAt: <ms>                      // per-record, for LWW merges
//       }
//     }
//   }
//
// The record KEY is an instance id and the `module` field is its type. Today
// they are the same string (the modal id) because every tool is a singleton;
// keeping them separate is what lets #29(a) — several terminals at once — drop
// in without a schema migration.
//
// `geom` is declared but NOT written by this slice: restoring geometry across
// ~20 structurally different windows needs its own pass (and visual QA), and
// half-restored positions are worse than none. Slice (e) restores WHICH modules
// are open and their mode; position/size is the next slice, and it writes here.
//
// MERGE: per-record last-write-wins on `updatedAt`. Records are never deleted
// (a closed module is `open: false`), so there are no tombstone races between
// two browsers.

const PREF_KEY = 'workspace-state';           // /api/prefs/<key>
const CACHE_KEY = 'odysseus.workspace.v1';    // optimistic per-browser cache
const SCHEMA_V = 1;
const FLUSH_MS = 800;                         // debounce before hitting prefs

const _empty = () => ({ v: SCHEMA_V, updatedAt: 0, migrated: false, modules: {} });

let _state = _empty();
let _dirty = false;
let _flushTimer = null;
let _serverReachable = true;
let _armed = false;            // see setTrackingArmed()
const _subs = new Set();

let _resolveReady;
const _readyPromise = new Promise((r) => { _resolveReady = r; });

// ── plumbing ──────────────────────────────────────────────────────────────

function _now() { return Date.now(); }

function _sane(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.v !== SCHEMA_V) return null;           // future/old schema: ignore
  if (!raw.modules || typeof raw.modules !== 'object') return null;
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

/** Per-record last-write-wins. Neither side is assumed authoritative: the
 *  server holds what other devices wrote, the cache holds writes this browser
 *  may not have flushed yet (a tab closed mid-debounce). */
function _merge(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = {
    v: SCHEMA_V,
    updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
    migrated: !!(a.migrated || b.migrated),
    modules: {},
  };
  const ids = new Set([...Object.keys(a.modules || {}), ...Object.keys(b.modules || {})]);
  for (const id of ids) {
    const ra = a.modules[id];
    const rb = b.modules[id];
    if (!ra) { out.modules[id] = rb; continue; }
    if (!rb) { out.modules[id] = ra; continue; }
    out.modules[id] = (rb.updatedAt || 0) > (ra.updatedAt || 0) ? rb : ra;
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

function _notify(id) {
  for (const fn of _subs) {
    try { fn(id, _state.modules[id] || null); } catch (e) { console.warn('[workspaceState] subscriber failed:', e); }
  }
}

/**
 * Apply a partial change to one record. Returns true if anything changed.
 *
 * `stamp` overrides the record's `updatedAt`; the legacy migration passes an
 * ancient one on purpose, so a value imported from this browser's old keys can
 * never outrank what another device already wrote to the server.
 */
function _write(id, partial, stamp) {
  if (!id) return false;
  const prev = _state.modules[id] || null;
  const next = { module: id, open: false, minimized: false, mode: null, dock: null, geom: null, openedAt: 0, ...(prev || {}), ...partial };
  // Skip no-op writes so the 1s visibility sweep doesn't push a PUT per second.
  if (prev) {
    let same = true;
    for (const k of Object.keys(partial)) {
      if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) { same = false; break; }
    }
    if (same) return false;
  }
  next.updatedAt = Number.isFinite(stamp) ? stamp : _now();
  _state.modules[id] = next;
  _state.updatedAt = Math.max(_state.updatedAt || 0, next.updatedAt);
  _dirty = true;
  _writeCache();
  _scheduleFlush();
  _notify(id);
  return true;
}

// ── legacy migration ──────────────────────────────────────────────────────
//
// Fold what the widgets already persisted into the shell state, so nobody
// loses the layout they had when this ships. FILL-ONLY: it never overwrites a
// field the shell state already defines, which is what makes it safe to run
// twice (once against the local cache, once after the server merge) and safe
// on a browser whose legacy keys are older than another device's state.
//
// The legacy keys are READ, never deleted: this release can be rolled back and
// the widgets still find their own values.

const LEGACY_HOSTSTATS_MODE = 'odysseus.hostStats.viewMode.v1';
const LEGACY_DOCK_PREFIX = 'odysseus-modal-remembered-dock-';

function _migrateLegacy(stamp) {
  let touched = false;
  try {
    const mode = localStorage.getItem(LEGACY_HOSTSTATS_MODE);
    if ((mode === 'compact' || mode === 'full') && !_state.modules['hoststats-modal']?.mode) {
      touched = _write('hoststats-modal', { mode }, stamp) || touched;
    }
  } catch (_) {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LEGACY_DOCK_PREFIX)) continue;
      const id = k.slice(LEGACY_DOCK_PREFIX.length);
      const side = localStorage.getItem(k);
      if ((side === 'left' || side === 'right') && !_state.modules[id]?.dock) {
        touched = _write(id, { dock: side }, stamp) || touched;
      }
    }
  } catch (_) {}
  return touched;
}

// ── boot ──────────────────────────────────────────────────────────────────
//
// Two phases on purpose. The cache is read SYNCHRONOUSLY at module-eval time,
// before any tool's init() runs, so a widget asking "what mode was I in?" gets
// an answer without waiting for the network (that is the pattern host-stats
// already proved: apply the mode at page load, not at panel open). The server
// read lands later and reconciles — which is the path that carries state from
// another device, or back from a signout that wiped this browser.

const _cached = _readCache();
if (_cached) _state = _cached;
// Stamped ancient so the server copy (another device, or this user's state
// from before the localStorage wipe) always wins the merge below.
_migrateLegacy(1);

(async () => {
  const server = await _fetchServer();
  if (server) _state = _merge(_state, server);
  const migrated = _migrateLegacy();
  if (!_state.migrated) { _state.migrated = true; _dirty = true; }
  _writeCache();
  if (_dirty || migrated) _scheduleFlush();
  _resolveReady(_state);
})();

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
}

// ── public API ────────────────────────────────────────────────────────────

/** Resolves once the server state has been merged in (or has failed). */
export function ready() { return _readyPromise; }

/** Whether the last server round-trip worked. False ⇒ cache-only degraded mode. */
export function isServerReachable() { return _serverReachable; }

/** Synchronous read — serves the cache before ready() resolves. */
export function get(id) { return _state.modules[id] ? { ...(_state.modules[id]) } : null; }

/** Every record, cloned. */
export function all() {
  const out = {};
  for (const [id, rec] of Object.entries(_state.modules)) out[id] = { ...rec };
  return out;
}

/** Records that were left open, oldest-opened first (restore order = z-order). */
export function openInstances() {
  return Object.entries(_state.modules)
    .filter(([, r]) => r && r.open)
    .map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => (a.openedAt || 0) - (b.openedAt || 0));
}

export function subscribe(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

/**
 * TRACKING ARM. Nothing is recorded until the restore pass has run.
 *
 * Without this the shell would eat its own state: at page load NOTHING is open
 * yet, so the visibility sweep would immediately write `open: false` over every
 * module the user had left open — erasing precisely what we are about to
 * restore. workspaceRestore.js arms tracking when its pass is done.
 */
export function setTrackingArmed(on) { _armed = !!on; }
export function isTrackingArmed() { return _armed; }

export function markOpen(id, extra = {}) {
  if (!_armed) return false;
  const prev = _state.modules[id];
  const partial = { open: true, minimized: false, ...extra };
  // Only stamp the open time on the closed→open transition. Re-stamping it on
  // every sweep would make each pass a "change" and turn the 1s scan into a
  // PUT-per-second against /api/prefs.
  if (!prev || !prev.open) partial.openedAt = _now();
  return _write(id, partial);
}

export function markMinimized(id, minimized = true) {
  if (!_armed) return false;
  return _write(id, { open: true, minimized: !!minimized });
}

export function markClosed(id) {
  if (!_armed) return false;
  if (!_state.modules[id]) return false;      // never seen open — don't create noise
  return _write(id, { open: false, minimized: false });
}

/** full ⇄ compact. Written even before arming: it is a user preference, not a
 *  window-visibility fact, so there is no self-erasing hazard. */
export function setMode(id, mode) {
  return _write(id, { mode: mode === 'compact' ? 'compact' : 'full' });
}

export function setDock(id, side) {
  return _write(id, { dock: (side === 'left' || side === 'right') ? side : null });
}

/** Reserved for the geometry slice; nothing calls it yet (see header). */
export function setGeometry(id, geom) {
  if (!geom) return _write(id, { geom: null });
  const { x, y, w, h } = geom;
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return false;
  return _write(id, { geom: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) } });
}

const WorkspaceState = {
  ready, isServerReachable, get, all, openInstances, subscribe,
  setTrackingArmed, isTrackingArmed,
  markOpen, markMinimized, markClosed, setMode, setDock, setGeometry, flush,
};

export default WorkspaceState;
