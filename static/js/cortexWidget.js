// ============================================
// CLAUDE · CORTEX panel — status of Claude's usage limits (5h session window,
// weekly window, per-model weekly scoped limits, and real out-of-pocket
// spend/overage) on the HOST machine (cortex, née claude-brain), surfaced
// inside Odysseus.
//
// The host writes its live snapshot to ~/.cache/cortex/state.json. axon runs
// as a HOST process (systemd --user axon-maincar) so it can read that file
// directly, and exposes it same-origin via GET /api/cortex/quota:
//
//   200 OK, data available:
//     { "ok": true, "data": <raw ~/.cache/cortex/state.json content> }
//
//   200 OK, degraded (file missing / unreadable / unparseable — cortex never
//   ran on this host, or hasn't written a snapshot yet):
//     { "ok": false, "reason": "not_found" | "invalid_json" | "read_error" | "no_home",
//       "detail": "..." }
//
// `data` is passed through VERBATIM from cortex's own harness — the exact
// same contract the real plasmoid KDE widget consumes (cortex repo,
// src/plasmoid/contents/ui/main.qml). This widget's render logic (percent
// colors, reset wording, $ equivalents, per-model rows, real-spend section,
// footer) is a direct JS port of that QML so the two widgets read alike:
//
//   data.account_email, data.account_mismatch, data.basis, data.updated_at
//   data.five_hour   { percent, cost_usd, resets_at, tokens_used, models[] }
//   data.weekly      { percent, cost_usd, resets_at, tokens_used, week_start }
//   data.limits[]    { kind: "session"|"weekly_all"|"weekly_scoped", model, percent, resets_at }
//   data.spend       { used, cap, currency, percent, enabled }
//   data.extra_usage { used_credits, monthly_limit, currency, utilization, enabled }
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

// Mirrors pctColor() in cortex's own plasmoid (main.qml): orange (default
// accent) always, red ONLY past 90% (throttle warning). No intermediate
// "warn" tier — deliberately simpler than hostStats' temp/gpu tones.
function quotaTone(pct) {
  if (pct == null) return null;
  return pct > 90 ? 'hot' : null;
}

function fmtPct(n) {
  return (typeof n === 'number' && isFinite(n)) ? n.toFixed(1) : '—';
}

function fmtInt(n) {
  return (typeof n === 'number' && isFinite(n)) ? Math.round(n).toLocaleString() : '—';
}

function fmtMoney(v, cur) {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  const sym = cur === 'USD' ? '$' : (cur ? cur + ' ' : '$');
  return sym + v.toFixed(2);
}

// true si el instante ISO ya pasó (o es ahora mismo). Espeja isPast() del QML.
function isPastIso(iso) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (isNaN(t)) return false;
  return t <= Date.now();
}

// Reset específico/útil — espeja resetDetail() del QML: <24h → "en 4h36m";
// ≥24h → "mié@7:59" (día abreviado en español + hora 12h, sin am/pm).
function resetDetail(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const secs = (t - Date.now()) / 1000;
  if (secs < 86400) {
    const total = Math.max(0, Math.round(secs));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (h > 0) return m > 0 ? `en ${h}h${m}m` : `en ${h}h`;
    if (total >= 60) return `en ${m}m`;
    return 'en <1m';
  }
  const d = new Date(t);
  const wd = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][d.getDay()];
  let hh = d.getHours() % 12;
  if (hh === 0) hh = 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${wd}@${hh}:${mm}`;
}

// Espeja relativeTime() del QML: "hace Xunit" / "en Xunit", unidad la más
// legible (s/min/h/d) según la magnitud.
function relativeTime(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (isNaN(t)) return String(iso);
  const diff = Math.round((t - Date.now()) / 1000);
  const abs = Math.abs(diff);
  let val, unit;
  if (abs < 60) { val = abs; unit = 's'; }
  else if (abs < 3600) { val = Math.round(abs / 60); unit = 'min'; }
  else if (abs < 86400) { val = Math.round(abs / 3600); unit = 'h'; }
  else { val = Math.round(abs / 86400); unit = 'd'; }
  return diff < 0 ? `hace ${val}${unit}` : `en ${val}${unit}`;
}

// Una sección "Sesión (5h)" / "Semanal (7d)" / por-modelo: título + %, barra,
// caption de reset + $equiv. Espeja el component UsageSection del QML —
// misma composición (título+pct arriba, barra, caption abajo), un solo bloque
// reusado para las tres variantes (5h, 7d, por-modelo).
function usageSectionHtml(title, block) {
  const pct = block && typeof block.percent === 'number' ? block.percent : null;
  const tone = quotaTone(pct);
  const pctClass = 'cortex-pct' + (tone ? ' hs-' + tone : '');
  const pctLabel = pct != null ? fmtPct(pct) + '%' : '—';

  let caption = '';
  if (block) {
    const past = isPastIso(block.resets_at);
    caption = past
      ? `Se restableció ${relativeTime(block.resets_at)} · actualizando…`
      : `Se restablece ${resetDetail(block.resets_at)}`;
    if (typeof block.cost_usd === 'number') {
      caption += ` · ≈ $${block.cost_usd.toFixed(2)} (API equiv local)`;
    }
  }

  return `<div class="cortex-usage">`
    + `<div class="cortex-usage-head"><span>${esc(title)}</span><span class="${pctClass}">${pctLabel}</span></div>`
    + segBar(pct, tone)
    + `<div class="cortex-usage-caption">${esc(caption)}</div>`
    + `</div>`;
}

// Sección de GASTO REAL (dinero de bolsillo) + sobreuso — distinta del
// "≈ $ (API equiv local)" de arriba, que es el equivalente incluido del
// plan. Espeja SpendSection del QML.
function spendSectionHtml(spend, extra) {
  if (!spend || spend.enabled !== true) return '';
  const pct = typeof spend.percent === 'number' ? spend.percent : null;
  const tone = quotaTone(pct);
  const pctClass = 'cortex-pct' + (tone ? ' hs-' + tone : '');
  const headline = fmtMoney(spend.used, spend.currency);

  let caption = `${fmtMoney(spend.used, spend.currency)} / ${fmtMoney(spend.cap, spend.currency)}`;
  if (spend.currency) caption += ` ${spend.currency}`;
  caption += ' — gasto real de bolsillo (no el equivalente incluido del plan)';
  if (extra && extra.enabled === true && extra.used_credits != null) {
    caption += `\nSobreuso: ${fmtInt(extra.used_credits)} / ${fmtInt(extra.monthly_limit)} créditos`;
    if (typeof extra.utilization === 'number') caption += ` (${extra.utilization.toFixed(1)}%)`;
  }

  return `<div class="cortex-usage">`
    + `<div class="cortex-usage-head"><span>Gasto real</span><span class="${pctClass}">${esc(headline)}</span></div>`
    + segBar(pct, tone)
    + `<div class="cortex-usage-caption cortex-usage-caption-multiline">${esc(caption)}</div>`
    + `</div>`;
}

// Límites semanales acotados a UN modelo (weekly_scoped con .model). Efímeros
// y cambiantes → se renderizan dinámicamente, sin hardcodear modelos. Espeja
// scopedLimits del QML.
function scopedLimits(limits) {
  if (!Array.isArray(limits)) return [];
  return limits.filter((l) => l && l.kind === 'weekly_scoped' && l.model);
}

// Línea de pie: cuenta + cadencia de refresco + hace-cuánto del snapshot.
// Espeja el PC3.Label del footer en el QML (incluye el aviso de account_mismatch).
function footerText(data) {
  if (!data) return 'cargando…';
  const account = data.account_email || (data.basis === 'oauth' ? 'datos reales' : 'estimado local');
  const updated = data.updated_at ? relativeTime(data.updated_at) : '—';
  if (data.account_mismatch === true) {
    return `⚠ ${account} no es la cuenta fijada · ⟳ 5 min + al reset 5h · act. ${updated}`;
  }
  return `${account} · ⟳ 5 min + al reset 5h · act. ${updated}`;
}

function render(data) {
  const body = $('cortex-body');
  if (!body) return;

  let html = '<div class="hs-section-label">[ LÍMITES DE USO ]</div>';
  html += usageSectionHtml('Sesión (5 h)', data.five_hour);
  html += usageSectionHtml('Semanal (7 d)', data.weekly);

  const scoped = scopedLimits(data.limits);
  if (scoped.length) {
    html += '<div class="hs-section-label">[ POR MODELO (SEMANAL) ]</div>';
    for (const l of scoped) html += usageSectionHtml(l.model, l);
  }

  const spendHtml = spendSectionHtml(data.spend, data.extra_usage);
  if (spendHtml) html += spendHtml;

  const mismatchClass = data.account_mismatch === true ? ' cortex-foot-warn' : '';
  html += `<div class="cortex-foot${mismatchClass}">${esc(footerText(data))}</div>`;

  body.innerHTML = html;
}

// El endpoint respondió pero {ok:false} (archivo ausente/ilegible en el host)
// — degradación HONESTA, distinta de un error de red/parseo del propio fetch.
function renderDegraded(reason, detail) {
  const body = $('cortex-body');
  if (!body) return;
  const why = {
    not_found: 'cortex nunca corrió en este host (o aún no escribió su primer snapshot)',
    invalid_json: 'el snapshot de cortex está corrupto',
    read_error: 'no se pudo leer el snapshot de cortex',
    no_home: 'axon no tiene $HOME configurado',
  }[reason] || (detail || 'sin datos');
  body.innerHTML = '<div class="hs-section-label">[ LÍMITES DE USO ]</div>'
    + `<div class="hs-empty">[ SIN DATOS ] ${esc(why)}</div>`;
}

function renderError(msg) {
  const body = $('cortex-body');
  if (!body) return;
  body.innerHTML = '<div class="hs-section-label">[ LÍMITES DE USO ]</div>'
    + `<div class="hs-empty">[ SIN DATOS ] ${esc(msg || 'cortex monitor unreachable')}</div>`;
}

async function poll() {
  if (_inFlight) return;
  _inFlight = true;
  const dot = $('cortex-live-dot');
  try {
    const r = await fetch(ENDPOINT, { headers: { Accept: 'application/json' } });
    if (r.status === 404) {
      // axon viejo sin el endpoint cableado todavía (fallback de compatibilidad).
      renderDegraded('not_found', `${ENDPOINT} aún no está cableado en axon`);
      if (dot) dot.classList.add('stale');
      return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const payload = await r.json();
    if (!payload || payload.ok !== true || !payload.data) {
      renderDegraded(payload && payload.reason, payload && payload.detail);
      if (dot) dot.classList.add('stale');
      return;
    }
    render(payload.data);
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
