// ============================================
// HOST STATS panel — reactor-console host hardware monitor.
//
// Polls /api/hwfit/live (the live seam over hwfit) and renders a
// reactor-style read-out: per-GPU load / VRAM / temp, the resident Ollama
// model, CPU load and RAM. The look is dionysus-reactor (bracketed [ LABELS ],
// segmented bars, monospace) but painted entirely with Odysseus theme tokens
// (--fg/--bg/--panel/--border/--accent-*), so it stays native and respects the
// active light/dark theme.
//
// Self-contained on purpose: it reads ONE endpoint and owns its own DOM, so it
// can later be wrapped as a Tier-A plugin iframe-card without a rewrite.
// ============================================

const MODAL_ID = 'hoststats-modal';
const ENDPOINT = '/api/hwfit/live';
const REFRESH_MS = 1500;
const SEGMENTS = 24; // segmented-bar resolution

let _timer = null;
let _inFlight = false;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

// A segmented bar: SEGMENTS cells, filled up to `pct` (0..100). `tone` picks
// the fill color class (ok / warn / hot) so temp/VRAM can shift color as they
// climb. Degrades to an all-empty bar when pct is null/NaN.
function segBar(pct, tone) {
  const p = (typeof pct === 'number' && isFinite(pct)) ? Math.max(0, Math.min(100, pct)) : null;
  const filled = p == null ? 0 : Math.round((p / 100) * SEGMENTS);
  let cells = '';
  for (let i = 0; i < SEGMENTS; i++) {
    cells += `<span class="hs-seg${i < filled ? ' on' : ''}"></span>`;
  }
  return `<div class="hs-bar${tone ? ' hs-' + tone : ''}${p == null ? ' hs-bar-na' : ''}">${cells}</div>`;
}

// Color tone thresholds shared by load-like metrics (0..100).
function loadTone(pct) {
  if (pct == null) return null;
  if (pct >= 90) return 'hot';
  if (pct >= 70) return 'warn';
  return 'ok';
}
function tempTone(c) {
  if (c == null) return null;
  if (c >= 84) return 'hot';
  if (c >= 70) return 'warn';
  return 'ok';
}

function fmt(n, digits) {
  return (typeof n === 'number' && isFinite(n)) ? n.toFixed(digits == null ? 0 : digits) : '—';
}

function box(label, valueHtml, extraClass) {
  return `<div class="hs-box${extraClass ? ' ' + extraClass : ''}">`
    + `<div class="hs-box-label">[ ${esc(label)} ]</div>`
    + `<div class="hs-box-val">${valueHtml}</div>`
    + `</div>`;
}

function gpuCard(g) {
  const util = g.util;
  const memPct = g.mem_percent;
  const temp = g.temp_c;
  const title = `GPU${g.index} · ${esc(g.name || 'GPU')}`;
  return `<div class="hs-gpu">`
    + `<div class="hs-gpu-title">[ ${title} ]</div>`
    + `<div class="hs-metric">`
      + `<div class="hs-metric-head"><span>GPU LOAD</span><span class="hs-metric-num">${fmt(util)}%</span></div>`
      + segBar(util, loadTone(util))
    + `</div>`
    + `<div class="hs-metric">`
      + `<div class="hs-metric-head"><span>VRAM</span><span class="hs-metric-num">${fmt(g.mem_used_gb, 1)} / ${fmt(g.mem_total_gb, 1)} GB</span></div>`
      + segBar(memPct, loadTone(memPct))
    + `</div>`
    + `<div class="hs-metric hs-metric-temp">`
      + `<div class="hs-metric-head"><span>GPU TEMP</span></div>`
      + `<div class="hs-temp-read hs-${tempTone(temp) || 'ok'}">${temp == null ? '—' : '+' + fmt(temp) + '°C'}</div>`
    + `</div>`
    + `</div>`;
}

function render(data) {
  const body = $('hoststats-body');
  if (!body) return;
  const err = (data && data.errors) || {};
  const gpus = (data && data.gpus) || [];
  const cpu = (data && data.cpu) || {};
  const ram = (data && data.ram) || {};
  const models = (data && data.models) || [];

  let html = '';

  // ── GPUs ──
  html += `<div class="hs-section-label">[ GPU ]</div>`;
  if (gpus.length) {
    html += `<div class="hs-gpu-grid">${gpus.map(gpuCard).join('')}</div>`;
  } else {
    html += `<div class="hs-empty">[ NO GPU ] ${esc(err.gpu || 'not detected')}</div>`;
  }

  // ── Loaded model ──
  html += `<div class="hs-section-label">[ MODEL LOADED ]</div>`;
  if (models.length) {
    html += `<div class="hs-models">` + models.map((m) => (
      `<div class="hs-model">`
      + `<span class="hs-model-name">${esc(m.name || 'model')}</span>`
      + `<span class="hs-model-meta">${m.size_gb != null ? fmt(m.size_gb, 1) + ' GB' : ''}`
      + `${m.processor ? ' · ' + esc(m.processor) : ''}</span>`
      + `</div>`
    )).join('') + `</div>`;
  } else {
    const why = err.ollama ? 'ollama offline' : 'none resident';
    html += `<div class="hs-empty">[ IDLE ] ${esc(why)}</div>`;
  }

  // ── CPU + RAM ──
  html += `<div class="hs-section-label">[ SYSTEM ]</div>`;
  html += `<div class="hs-sys">`;
  html += `<div class="hs-metric">`
    + `<div class="hs-metric-head"><span>CPU LOAD</span><span class="hs-metric-num">${fmt(cpu.util)}%`
    + `${cpu.cores ? ' · ' + cpu.cores + 'c' : ''}${cpu.load1 != null ? ' · ' + fmt(cpu.load1, 2) : ''}</span></div>`
    + segBar(cpu.util, loadTone(cpu.util))
    + `</div>`;
  html += `<div class="hs-metric">`
    + `<div class="hs-metric-head"><span>RAM</span><span class="hs-metric-num">${fmt(ram.used_gb, 1)} / ${fmt(ram.total_gb, 1)} GB</span></div>`
    + segBar(ram.percent, loadTone(ram.percent))
    + `</div>`;
  html += `</div>`;

  // ── Footer: host + timestamp ──
  const host = (data && data.host) || '';
  const ts = (data && data.ts) ? new Date(data.ts * 1000).toLocaleTimeString() : '';
  html += `<div class="hs-foot">[ HOST ] ${esc(host || '—')} <span class="hs-foot-ts">${esc(ts)}</span></div>`;

  body.innerHTML = html;
}

function renderError(msg) {
  const body = $('hoststats-body');
  if (!body) return;
  body.innerHTML = `<div class="hs-empty">[ NO SIGNAL ] ${esc(msg || 'host monitor unreachable')}</div>`;
}

async function poll() {
  if (_inFlight) return;
  _inFlight = true;
  const dot = $('hoststats-live-dot');
  try {
    const r = await fetch(ENDPOINT, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
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
    // Pause when the tab is hidden or the modal is closed/minimized.
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
  // If minimized via modalManager, let it restore.
  if (window.Modals && window.Modals.isMinimized && window.Modals.isMinimized(MODAL_ID)) {
    window.Modals.restore(MODAL_ID);
  }
  m.classList.remove('hidden');
  const body = $('hoststats-body');
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
  const rail = $('rail-hoststats');
  if (rail) rail.addEventListener('click', toggle);
  const closeBtn = $('close-hoststats-modal');
  if (closeBtn) closeBtn.addEventListener('click', close);
  // Refresh immediately when the tab becomes visible again while open.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isOpen()) poll();
  });
  // Expose a tiny handle for slash-commands / other modules.
  window.hostStats = { open, close, toggle };
}

if (document.readyState !== 'loading') init();
else document.addEventListener('DOMContentLoaded', init);

export default { open, close, toggle };
