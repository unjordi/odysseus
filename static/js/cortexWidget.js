// ============================================
// CLAUDE · CORTEX panel — status of Claude's 5-hour quota window and brain
// state on the HOST machine (claude-brain), surfaced inside Odysseus.
//
// The host writes its live snapshot to ~/.cache/claude-brain/state.json, but
// the Odysseus container cannot read that file directly. So this widget
// fetches it from a same-origin endpoint (GET /api/cortex/quota) that the
// axon main car is expected to expose by reading/proxying that file. THE
// ENDPOINT DOES NOT EXIST YET — this widget is written to degrade with grace
// (404 / network error / empty payload) until it's wired up, per its own
// spec (see the header comment on ENDPOINT below and the PR report).
//
// Self-contained, same pattern as hostStats.js / axonConfig.js: one endpoint,
// its own DOM, its own polling loop, its own rail wiring via _railToolMap
// (app.js): rail-cortex -> tool-cortex-btn.click() -> the listener below. A
// raw addEventListener on the rail node does NOT work (documented gotcha,
// already hit twice in this fork) — the rail dispatch only forwards to the
// tool-*-btn id registered in _railToolMap.
// ============================================

import { makeWindowDraggable } from './windowDrag.js';

const MODAL_ID = 'cortex-modal';

// ── Endpoint contract (to be wired server-side in the axon main car) ──
//
//   GET /api/cortex/quota
//
//   200 OK, quota data available:
//     {
//       "ok": true,
//       "host": "cachy",                          // hostname running claude-brain (optional)
//       "ts": 1756900000,                          // unix seconds, when this snapshot was read
//       "five_hour": {
//         "percent": 42.5,                         // 0-100, % of the 5h window consumed
//         "resets_at": "2026-09-03T18:00:00-06:00", // ISO-8601 (offset or Z); a raw unix-seconds
//                                                    // number is also accepted as a fallback
//         "tokens_used": 128000,                    // optional
//         "token_limit": 300000                     // optional — omit if unknown, widget then
//                                                    // shows tokens_used alone with no bar
//       }
//     }
//
//   200 OK, endpoint alive but no active window yet:
//     { "ok": true, "five_hour": null, "host": "...", "ts": ... }
//
//   404 (not wired yet) or any non-2xx / network failure: the widget shows a
//   graceful "sin datos" / "endpoint pendiente" state — it never throws or
//   blanks the panel.
const ENDPOINT = '/api/cortex/quota';
const REFRESH_MS = 30000; // quota drifts slowly — no need to hammer it like host stats
const SEGMENTS = 24;

let _timer = null;
let _inFlight = false;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

// Same segmented-bar language as hostStats.js (hs-bar/hs-seg are generic
// theme-aware atoms, not scoped to that panel) — degrades to an all-empty bar
// when pct is null/NaN.
function segBar(pct, tone) {
  const p = (typeof pct === 'number' && isFinite(pct)) ? Math.max(0, Math.min(100, pct)) : null;
  const filled = p == null ? 0 : Math.round((p / 100) * SEGMENTS);
  let cells = '';
  for (let i = 0; i < SEGMENTS; i++) {
    cells += `<span class="hs-seg${i < filled ? ' on' : ''}"></span>`;
  }
  return `<div class="hs-bar${tone ? ' hs-' + tone : ''}${p == null ? ' hs-bar-na' : ''}">${cells}</div>`;
}

function quotaTone(pct) {
  if (pct == null) return null;
  if (pct >= 90) return 'hot';
  if (pct >= 70) return 'warn';
  return 'ok';
}

function fmtPct(n) {
  return (typeof n === 'number' && isFinite(n)) ? n.toFixed(1) : '—';
}

function fmtInt(n) {
  return (typeof n === 'number' && isFinite(n)) ? Math.round(n).toLocaleString() : '—';
}

// Accepts an ISO-8601 string OR a raw unix-seconds number (fallback for a
// simpler server implementation) and returns a Date, or null if unparseable.
function parseResetsAt(v) {
  if (v == null) return null;
  if (typeof v === 'number' && isFinite(v)) return new Date(v * 1000);
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function fmtResetsAt(v) {
  const d = parseResetsAt(v);
  if (!d) return { abs: '—', rel: '' };
  const abs = d.toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
  const deltaMs = d.getTime() - Date.now();
  if (deltaMs <= 0) return { abs, rel: 'ya debería resetear' };
  const mins = Math.round(deltaMs / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const rel = h > 0 ? `en ${h}h ${m}m` : `en ${m}m`;
  return { abs, rel };
}

function render(data) {
  const body = $('cortex-body');
  if (!body) return;

  const fh = data && data.five_hour;
  let html = '';

  html += `<div class="hs-section-label">[ VENTANA 5H ]</div>`;
  if (!fh) {
    html += `<div class="hs-empty">[ SIN VENTANA ACTIVA ] no hay consumo registrado aún</div>`;
  } else {
    const pct = fh.percent;
    const tone = quotaTone(pct);
    html += `<div class="hs-metric">`
      + `<div class="hs-metric-head"><span>USO DE CUOTA</span><span class="hs-metric-num${tone ? ' hs-' + tone : ''}">${fmtPct(pct)}%</span></div>`
      + segBar(pct, tone)
      + `</div>`;

    const { abs, rel } = fmtResetsAt(fh.resets_at);
    html += `<div class="cortex-reset-row">`
      + `<span class="cortex-reset-label">[ RESETEA ]</span>`
      + `<span class="cortex-reset-val">${esc(abs)}${rel ? ' · ' + esc(rel) : ''}</span>`
      + `</div>`;

    if (fh.tokens_used != null) {
      html += `<div class="hs-section-label">[ TOKENS ]</div>`;
      if (fh.token_limit != null) {
        const tPct = fh.token_limit > 0 ? (fh.tokens_used / fh.token_limit) * 100 : null;
        html += `<div class="hs-metric">`
          + `<div class="hs-metric-head"><span>USADOS</span><span class="hs-metric-num">${fmtInt(fh.tokens_used)} / ${fmtInt(fh.token_limit)}</span></div>`
          + segBar(tPct, quotaTone(tPct))
          + `</div>`;
      } else {
        html += `<div class="cortex-reset-row">`
          + `<span class="cortex-reset-label">[ USADOS ]</span>`
          + `<span class="cortex-reset-val">${fmtInt(fh.tokens_used)}</span>`
          + `</div>`;
      }
    }
  }

  const host = (data && data.host) || '';
  const ts = (data && data.ts) ? new Date(data.ts * 1000).toLocaleTimeString() : '';
  html += `<div class="hs-foot">[ HOST ] ${esc(host || '—')} <span class="hs-foot-ts">${esc(ts)}</span></div>`;

  body.innerHTML = html;
}

function renderMissingEndpoint() {
  const body = $('cortex-body');
  if (!body) return;
  body.innerHTML = `<div class="hs-section-label">[ VENTANA 5H ]</div>`
    + `<div class="hs-empty">[ ENDPOINT PENDIENTE ] ${esc(ENDPOINT)} aún no está cableado en axon</div>`;
}

function renderError(msg) {
  const body = $('cortex-body');
  if (!body) return;
  body.innerHTML = `<div class="hs-section-label">[ VENTANA 5H ]</div>`
    + `<div class="hs-empty">[ SIN DATOS ] ${esc(msg || 'cortex monitor unreachable')}</div>`;
}

async function poll() {
  if (_inFlight) return;
  _inFlight = true;
  const dot = $('cortex-live-dot');
  try {
    const r = await fetch(ENDPOINT, { headers: { Accept: 'application/json' } });
    if (r.status === 404) {
      renderMissingEndpoint();
      if (dot) dot.classList.add('stale');
      return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (data && data.ok === false) throw new Error(data.error || 'respuesta no-ok');
    render(data);
    if (dot) dot.classList.remove('stale');
  } catch (e) {
    renderError(e && e.message);
    if (dot) dot.classList.add('stale');
  } finally {
    _inFlight = false;
  }
}

function isOpen() {
  const m = $(MODAL_ID);
  return m && !m.classList.contains('hidden');
}

function startPolling() {
  stopPolling();
  poll();
  _timer = setInterval(() => {
    if (document.hidden || !isOpen()) return;
    poll();
  }, REFRESH_MS);
}

function stopPolling() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

function open() {
  const m = $(MODAL_ID);
  if (!m) return;
  if (window.Modals && window.Modals.isMinimized && window.Modals.isMinimized(MODAL_ID)) {
    window.Modals.restore(MODAL_ID);
  }
  m.classList.remove('hidden');
  const body = $('cortex-body');
  if (body && !body.querySelector('.hs-section-label')) {
    body.innerHTML = '<div class="hoststats-loading">[ CONNECTING… ]</div>';
  }
  startPolling();
}

function close() {
  const m = $(MODAL_ID);
  if (m) m.classList.add('hidden');
  stopPolling();
}

function toggle() {
  if (isOpen()) close(); else open();
}

function init() {
  // Rail opens this INDIRECT: rail-cortex -> _railToolMap (app.js) ->
  // tool-cortex-btn.click() -> this listener. See header comment.
  const toolBtn = $('tool-cortex-btn');
  if (toolBtn) toolBtn.addEventListener('click', toggle);
  const closeBtn = $('close-cortex-modal');
  if (closeBtn) closeBtn.addEventListener('click', close);

  const modal = $(MODAL_ID);
  if (modal) {
    const content = modal.querySelector('.modal-content');
    const header = modal.querySelector('.modal-header');
    if (content && header) makeWindowDraggable(modal, { content, header });
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isOpen()) poll();
  });

  window.cortexWidget = { open, close, toggle };
}

if (document.readyState !== 'loading') init();
else document.addEventListener('DOMContentLoaded', init);

export default { open, close, toggle };
