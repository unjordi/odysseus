// ============================================
// CLAUDE · CORTEX panel — full replica of the real plasmoid KDE widget (cortex repo,
// src/plasmoid/contents/ui/main.qml): a sidebar with Límites / Resumen / Modelos /
// Proyectos / Chats / Cerebro, backed by axon's GET /api/cortex/{quota,stats,sessions,
// chats,brain} endpoints (feat/cortex-quota) — axon runs on the HOST so it reads the
// same caches under ~/.cache/cortex/*.json (and runs brain-scan.sh for the live
// Cerebro tab) that feed the real widget. Nothing here invents a data shape: every
// field/formula is a direct JS port of the QML's own properties/functions.
//
//   GET /api/cortex/quota    -> pestaña Límites: state.json (five_hour, weekly,
//                               limits[], spend, extra_usage, account_email…)
//   GET /api/cortex/stats    -> pestañas Resumen/Modelos/Proyectos: stats.json
//                               (summary, days[], models[], projects[])
//   GET /api/cortex/sessions -> complementa Resumen (conteo de sesiones por rango)
//                               y Proyectos (lista de sesiones por proyecto)
//   GET /api/cortex/chats    -> pestaña Chats (oculta si no hay conversaciones — el
//                               widget real hace lo mismo, ver TabRailButton idx 4)
//   GET /api/cortex/brain    -> pestaña Cerebro: corre brain-scan.sh scan EN VIVO
//
//   200 OK: { "ok": true, "data": <cache crudo> }
//   200 OK degradado: { "ok": false, "reason": "...", "detail": "..." } (archivo
//   ausente/corrupto en el host, o brain-scan.sh no encontrado/falló)
//
// Simplificaciones DELIBERADAS frente al widget de escritorio (documentadas, no
// silenciosas):
//   - Proyectos: la lista de sesiones expandida es de SOLO LECTURA (label + fecha).
//     El real permite click -> abrir terminal -> `claude --resume` y renombrar/mover
//     sesiones; eso es una acción de escritorio sin sentido dentro de un contenedor.
//   - Chats: se omite el footer "resumen del chat bajo el cursor" (hover-only, poco
//     valor en una lista ya visible).
//   - Cerebro: se expone el MISMO dato en vivo (brain-scan.sh scan: hooks presentes/
//     cableados, skills, versión, normas) pero como un resumen de salud simple — sin
//     el catálogo curado de tiers (~80 líneas hardcoded específicas del repo cortex)
//     ni las acciones de self-heal/self-update (mutan git en el host).
//
// Self-contained, same pattern as hostStats.js / axonConfig.js: one set of endpoints,
// its own DOM, its own polling loop, its own rail wiring via _railToolMap (app.js):
// rail-cortex -> tool-cortex-btn.click() -> the listener below. A raw addEventListener
// on the rail node does NOT work (documented gotcha, already hit twice in this fork)
// — the rail dispatch only forwards to the tool-*-btn id registered in _railToolMap.
// ============================================

import { makeWindowDraggable } from './windowDrag.js';

const MODAL_ID = 'cortex-modal';
const REFRESH_MS = 30000; // los caches drifean lento — no hay que hammerearlos como host stats
const SEGMENTS = 24;

const ENDPOINTS = {
  quota: '/api/cortex/quota',
  stats: '/api/cortex/stats',
  sessions: '/api/cortex/sessions',
  chats: '/api/cortex/chats',
  brain: '/api/cortex/brain',
  // `?knobs=1` trae en la MISMA respuesta el spec de knobs con su valor actual (broker-knobs.sh list).
  broker: '/api/cortex/broker?knobs=1',
};

const REASON_TEXT = {
  not_found: 'cortex no ha escrito este cache aún en este host',
  invalid_json: 'el cache de cortex está corrupto',
  read_error: 'no se pudo leer el cache de cortex',
  no_home: 'axon no tiene $HOME configurado',
  script_not_found: 'brain-scan.sh no se encontró en este host',
  exec_error: 'no se pudo ejecutar brain-scan.sh',
  'script-no-encontrado': 'los helpers del broker (broker-scan.sh / broker-knobs.sh) no están en este host',
  'ejecucion-fallo': 'no se pudieron ejecutar los helpers del broker',
  'json-invalido': 'los helpers del broker devolvieron algo que no es JSON',
};

const RANGE_LABELS = ['hoy', '7d', '30d', '∞'];
const MODEL_PALETTE = ['#e8884a', '#5b9bd5', '#9b6dd6', '#5fb98e', '#d6a15b', '#c96daa'];

// ── Estado del módulo ──
let _timer = null;
let _inFlight = false;
let _activeTab = 'limites';
let _rangeIdx = 3; // 0=hoy(0d atrás) 1=7d(6) 2=30d(29) 3=∞ — espeja rangeIdx del QML
let _expandedProject = '';
let _brainLoading = false;
let _brokerLoading = false;
let _bodyDelegationWired = false;

function makeEndpointState() { return { status: 'idle', data: null, message: '' }; }
const _quota = makeEndpointState();
const _stats = makeEndpointState();
const _sessions = makeEndpointState();
const _chats = makeEndpointState();
const _brain = makeEndpointState();
const _broker = makeEndpointState();
const _brokerKnobs = makeEndpointState();

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

// ---------- Fetch + degradación ----------
async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (r.status === 404) return { ok: false, reason: 'not_found', detail: `${url} aún no está cableado en axon` };
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function refreshCache(state, url) {
  try {
    const payload = await fetchJson(url);
    if (!payload || payload.ok !== true) {
      state.status = 'degraded';
      state.data = null;
      state.message = (payload && (REASON_TEXT[payload.reason] || payload.detail)) || 'sin datos';
    } else {
      state.status = 'ok';
      state.data = payload.data;
      state.message = '';
    }
  } catch (e) {
    state.status = 'error';
    state.data = null;
    state.message = (e && e.message) || 'cortex monitor unreachable';
  }
}

// ---------- Formato (puertos 1:1 de las funciones del QML) ----------
function segBar(pct, tone) {
  const p = (typeof pct === 'number' && isFinite(pct)) ? Math.max(0, Math.min(100, pct)) : null;
  const filled = p == null ? 0 : Math.round((p / 100) * SEGMENTS);
  let cells = '';
  for (let i = 0; i < SEGMENTS; i++) cells += `<span class="hs-seg${i < filled ? ' on' : ''}"></span>`;
  return `<div class="hs-bar${tone ? ' hs-' + tone : ''}${p == null ? ' hs-bar-na' : ''}">${cells}</div>`;
}

// pctColor() del QML: naranja (default) siempre, rojo SOLO >90% (throttle). Sin tier intermedio.
function quotaTone(pct) {
  if (pct == null) return null;
  return pct > 90 ? 'hot' : null;
}

function fmtPct(n) { return (typeof n === 'number' && isFinite(n)) ? n.toFixed(1) : '—'; }
function fmtInt(n) { return (typeof n === 'number' && isFinite(n)) ? Math.round(n).toLocaleString() : '—'; }
function fmtMoney(v, cur) {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  const sym = cur === 'USD' ? '$' : (cur ? cur + ' ' : '$');
  return sym + v.toFixed(2);
}
function fmtTok(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return '' + Math.round(n);
}
function fmtHour(h) {
  if (h == null || h < 0) return '—';
  const ampm = h < 12 ? 'a.m.' : 'p.m.';
  let hh = h % 12; if (hh === 0) hh = 12;
  return hh + ' ' + ampm;
}
function prettyModel(id) {
  if (!id) return '—';
  const parts = String(id).replace(/^claude-/, '').split('-');
  const fam = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  const noise = { preview: 1, exp: 1, latest: 1 };
  const tokens = []; let nums = [];
  const flush = () => { if (nums.length) { tokens.push(nums.join('.')); nums = []; } };
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (/^\d+$/.test(p)) { if (p.length >= 6) break; nums.push(p); }
    else if (/^\d+\.\d+$/.test(p)) { flush(); tokens.push(p); }
    else if (p && !noise[p.toLowerCase()]) { flush(); tokens.push(p.charAt(0).toUpperCase() + p.slice(1)); }
  }
  flush();
  return tokens.length ? fam + ' ' + tokens.join(' ') : fam;
}
function withAlpha(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function isPastIso(iso) {
  if (!iso) return false;
  const t = Date.parse(iso);
  return !isNaN(t) && t <= Date.now();
}
function resetDetail(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const secs = (t - Date.now()) / 1000;
  if (secs < 86400) {
    const total = Math.max(0, Math.round(secs));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60);
    if (h > 0) return m > 0 ? `en ${h}h${m}m` : `en ${h}h`;
    if (total >= 60) return `en ${m}m`;
    return 'en <1m';
  }
  const d = new Date(t);
  const wd = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][d.getDay()];
  let hh = d.getHours() % 12; if (hh === 0) hh = 12;
  return `${wd}@${hh}:${String(d.getMinutes()).padStart(2, '0')}`;
}
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
// relDate() del QML: granularidad de día desde el prefijo YYYY-MM-DD de un ISO.
function relDate(iso) {
  if (!iso || String(iso).length < 10) return '';
  const d = Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d)) return '';
  const days = Math.floor((Date.now() - d) / 86400000);
  if (days <= 0) return 'hoy';
  if (days === 1) return 'ayer';
  if (days < 7) return `hace ${days}d`;
  if (days < 30) return `hace ${Math.floor(days / 7)}sem`;
  return `hace ${Math.floor(days / 30)}mes`;
}

// ---------- Rango {hoy·7d·30d·∞} compartido por Resumen/Modelos/Proyectos/Chats ----------
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function dayKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function rangeCutoff() {
  const back = [0, 6, 29, -1][_rangeIdx];
  if (back < 0) return '';
  const d = new Date(); d.setDate(d.getDate() - back);
  return dayKey(d);
}
function computeRDays(stats) {
  if (!stats || !Array.isArray(stats.days)) return [];
  const cut = rangeCutoff();
  if (cut === '') return stats.days;
  return stats.days.filter((d) => (d.date || '') >= cut);
}
function aggBy(days, listKey, nameKey) {
  const acc = {}; const order = [];
  for (const day of days) {
    const list = day[listKey];
    if (!list) continue;
    for (const item of list) {
      const k = item[nameKey] || '?';
      if (!(k in acc)) { acc[k] = { inTok: 0, outTok: 0 }; order.push(k); }
      acc[k].inTok += item.in_tok || 0;
      acc[k].outTok += item.out_tok || 0;
    }
  }
  let grand = 0;
  for (const k in acc) grand += acc[k].inTok + acc[k].outTok;
  const rows = order.map((k) => {
    const tot = acc[k].inTok + acc[k].outTok;
    const row = { in_tok: acc[k].inTok, out_tok: acc[k].outTok, tot, pct: grand > 0 ? (tot * 100) / grand : 0 };
    row[nameKey] = k;
    return row;
  });
  rows.sort((a, b) => b.tot - a.tot);
  return rows;
}
function sumField(days, field) { return days.reduce((s, d) => s + (d[field] || 0), 0); }
function computeStreaks(stats) {
  if (!stats || !Array.isArray(stats.days) || !stats.days.length) return { cur: 0, max: 0 };
  const set = {};
  for (const d of stats.days) if (d.tokens > 0) set[d.date] = true;
  const keys = Object.keys(set).sort();
  let longest = 0, run = 0, prev = null;
  for (const k of keys) {
    const t = Date.parse(k);
    run = (prev !== null && (t - prev) === 86400000) ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = t;
  }
  let cur = 0; const d = new Date();
  if (!set[dayKey(d)]) d.setDate(d.getDate() - 1);
  while (set[dayKey(d)]) { cur++; d.setDate(d.getDate() - 1); }
  return { cur, max: longest };
}
function heatmapCells(stats) {
  if (!stats || !Array.isArray(stats.days) || !stats.days.length) return [];
  const m = {}; let minT = null, maxT = null;
  for (const d of stats.days) {
    m[d.date] = d.tokens;
    const t = Date.parse(d.date);
    if (minT === null || t < minT) minT = t;
    if (maxT === null || t > maxT) maxT = t;
  }
  if (minT === null) return [];
  const start = new Date(minT); start.setDate(start.getDate() - start.getDay());
  const end = new Date(maxT);
  const cells = []; const cur = new Date(start);
  while (cur <= end) { cells.push({ tokens: m[dayKey(cur)] || 0 }); cur.setDate(cur.getDate() + 1); }
  return cells;
}
function colorForIndex(list, key, name) {
  if (!Array.isArray(list)) return MODEL_PALETTE[0];
  const idx = list.findIndex((x) => x[key] === name);
  return MODEL_PALETTE[(idx < 0 ? 0 : idx) % MODEL_PALETTE.length];
}
function rSessionCount() {
  const sessions = _sessions.status === 'ok' && Array.isArray(_sessions.data) ? _sessions.data : null;
  if (!sessions) return 0;
  const cut = rangeCutoff();
  if (cut === '') return sessions.length;
  return sessions.filter((s) => String(s.updated_at || '').slice(0, 10) >= cut).length;
}
function sessionsForProject(name) {
  const sessions = _sessions.status === 'ok' && Array.isArray(_sessions.data) ? _sessions.data : [];
  const out = [];
  for (const s of sessions) { if (s.project === name) out.push(s); if (out.length >= 12) break; }
  return out;
}
function rangeFilterChats(chats) {
  const cut = rangeCutoff();
  if (cut === '') return chats;
  return chats.filter((c) => String(c.updated_at || c.created_at || '').slice(0, 10) >= cut);
}
function chatsByModel(cs) {
  const total = cs.length;
  if (!total) return [];
  const counts = {}; const order = [];
  for (const c of cs) {
    const k = c.model || '?';
    if (!(k in counts)) { counts[k] = 0; order.push(k); }
    counts[k]++;
  }
  return order.map((k) => ({ model: k, count: counts[k], pct: (counts[k] * 100) / total }))
    .sort((a, b) => b.count - a.count);
}

// ---------- Bloques HTML reusados ----------
function emptyStateInner(msg) { return `<div class="hs-empty">[ SIN DATOS ] ${esc(msg)}</div>`; }
function emptyStateHtml(label, msg) { return `<div class="hs-section-label">[ ${esc(label)} ]</div>${emptyStateInner(msg)}`; }
function loadingHtml(label) { return `<div class="hs-section-label">[ ${esc(label)} ]</div><div class="hoststats-loading">[ CONNECTING… ]</div>`; }
function stateMessage(state) { return state.status === 'idle' ? 'cargando…' : (state.message || 'sin datos'); }

function statCardHtml(label, value) {
  return `<div class="cortex-stat-card"><div class="cortex-stat-label">${esc(label)}</div><div class="cortex-stat-value">${esc(value)}</div></div>`;
}

function rangeFooterHtml() {
  const pills = RANGE_LABELS.map((label, i) => `<button type="button" class="cortex-range-pill${i === _rangeIdx ? ' active' : ''}" data-range="${i}">${esc(label)}</button>`).join('');
  return `<div class="cortex-range-footer">${pills}</div>`;
}

// Gráfica apilada por día (Modelos/Proyectos): cada segmento se escala por SU PROPIO
// tokens/máximo-del-rango (no por el total del día) — así el alto total del día
// representa fielmente el día vs. el pico del rango. Espeja chartArea del QML.
function stackedChartHtml(rDays, listKey, nameKey, colorFn) {
  if (!rDays.length) return '';
  let maxDay = 1;
  for (const d of rDays) maxDay = Math.max(maxDay, d.tokens || 0);
  const cols = rDays.map((d) => {
    const items = (d[listKey] || []).slice().sort((a, b) => (b.tokens || 0) - (a.tokens || 0)
      || String(a[nameKey] || '').localeCompare(String(b[nameKey] || '')));
    const segs = items.map((it) => {
      const h = maxDay > 0 ? Math.max(0, Math.min(100, ((it.tokens || 0) / maxDay) * 100)) : 0;
      const name = it[nameKey] || '?';
      return `<div class="cortex-chart-seg" style="height:${h}%;background:${colorFn(name)}" title="${esc(name)}: ${esc(fmtTok(it.tokens))}"></div>`;
    }).join('');
    return `<div class="cortex-chart-col" title="${esc(d.date || '')}: ${esc(fmtTok(d.tokens))}">${segs}</div>`;
  }).join('');
  return `<div class="cortex-chart">${cols}</div>`;
}

function heatmapHtml(stats) {
  const cells = heatmapCells(stats);
  if (!cells.length) return emptyStateInner('sin actividad registrada');
  const maxT = cells.reduce((m, c) => Math.max(m, c.tokens || 0), 1);
  const cellsHtml = cells.map((c) => {
    const t = c.tokens || 0;
    const style = t <= 0
      ? 'background: color-mix(in srgb, var(--fg) 8%, transparent)'
      : `background: color-mix(in srgb, var(--accent-primary, #e8884a) ${Math.round((0.25 + 0.75 * Math.min(1, t / maxT)) * 100)}%, transparent)`;
    return `<div class="cortex-heat-cell" style="${style}" title="${esc(fmtInt(t))} tokens"></div>`;
  }).join('');
  return `<div class="cortex-heatmap">${cellsHtml}</div>`;
}

// ---------- Pestaña Límites (quota) ----------
function usageSectionHtml(title, block) {
  const pct = block && typeof block.percent === 'number' ? block.percent : null;
  const tone = quotaTone(pct);
  const pctClass = 'cortex-pct' + (tone ? ' hs-' + tone : '');
  const pctLabel = pct != null ? fmtPct(pct) + '%' : '—';
  let caption = '';
  if (block) {
    const past = isPastIso(block.resets_at);
    caption = past ? `Se restableció ${relativeTime(block.resets_at)} · actualizando…` : `Se restablece ${resetDetail(block.resets_at)}`;
    if (typeof block.cost_usd === 'number') caption += ` · ≈ $${block.cost_usd.toFixed(2)} (API equiv local)`;
  }
  return `<div class="cortex-usage">`
    + `<div class="cortex-usage-head"><span>${esc(title)}</span><span class="${pctClass}">${pctLabel}</span></div>`
    + segBar(pct, tone)
    + `<div class="cortex-usage-caption">${esc(caption)}</div>`
    + `</div>`;
}
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
function scopedLimits(limits) {
  return Array.isArray(limits) ? limits.filter((l) => l && l.kind === 'weekly_scoped' && l.model) : [];
}
function footerText(data) {
  if (!data) return 'cargando…';
  const account = data.account_email || (data.basis === 'oauth' ? 'datos reales' : 'estimado local');
  const updated = data.updated_at ? relativeTime(data.updated_at) : '—';
  if (data.account_mismatch === true) return `⚠ ${account} no es la cuenta fijada · ⟳ 5 min + al reset 5h · act. ${updated}`;
  return `${account} · ⟳ 5 min + al reset 5h · act. ${updated}`;
}
function renderLimitesTab() {
  if (_quota.status !== 'ok' || !_quota.data) {
    return _quota.status === 'idle' ? loadingHtml('LÍMITES DE USO') : emptyStateHtml('LÍMITES DE USO', stateMessage(_quota));
  }
  const data = _quota.data;
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
  return html;
}

// ---------- Pestaña Resumen ----------
function renderResumenTab() {
  if (_stats.status !== 'ok' || !_stats.data) {
    return _stats.status === 'idle' ? loadingHtml('RESUMEN') : emptyStateHtml('RESUMEN', stateMessage(_stats));
  }
  const stats = _stats.data;
  const rDays = computeRDays(stats);
  const rTokens = sumField(rDays, 'tokens');
  const rMessages = sumField(rDays, 'messages');
  const rCost = sumField(rDays, 'cost');
  const rActiveDays = rDays.filter((d) => (d.tokens || 0) > 0).length;
  const rModels = aggBy(rDays, 'models', 'model');
  const streaks = computeStreaks(stats);
  const summary = stats.summary || {};
  const sessCount = _rangeIdx === 3 ? fmtInt(summary.sessions) : String(rSessionCount());

  const cards = [
    ['Sesiones', sessCount],
    ['Mensajes', fmtInt(rMessages)],
    ['Tokens totales', fmtTok(rTokens)],
    ['Días activos', String(rActiveDays)],
    ['Racha actual', streaks.cur + 'd'],
    ['Racha más larga', streaks.max + 'd'],
    ['Hora pico', fmtHour(summary.peak_hour)],
    ['Modelo favorito', rModels.length ? prettyModel(rModels[0].model) : '—'],
    ['Costo API-equiv', '$' + rCost.toFixed(0)],
  ];

  let html = '<div class="hs-section-label">[ RESUMEN ]</div>';
  html += `<div class="cortex-stat-grid">${cards.map(([l, v]) => statCardHtml(l, v)).join('')}</div>`;
  html += '<div class="hs-section-label">[ ACTIVIDAD DIARIA (LOCAL) ]</div>';
  html += heatmapHtml(stats);
  html += rangeFooterHtml();
  return html;
}

// ---------- Pestaña Modelos ----------
function modelRowHtml(stats, m) {
  const color = colorForIndex(stats.models, 'model', m.model);
  return `<div class="cortex-list-row">`
    + `<span class="cortex-swatch" style="background:${color}"></span>`
    + `<span class="cortex-list-name">${esc(prettyModel(m.model))}</span>`
    + `<span class="cortex-list-meta">${esc(fmtTok(m.in_tok))} in · ${esc(fmtTok(m.out_tok))} out</span>`
    + `<span class="cortex-list-pct" style="color:${color}">${m.pct.toFixed(1)}%</span>`
    + `</div>`;
}
function renderModelosTab() {
  if (_stats.status !== 'ok' || !_stats.data) {
    return _stats.status === 'idle' ? loadingHtml('USO POR MODELO') : emptyStateHtml('USO POR MODELO', stateMessage(_stats));
  }
  const stats = _stats.data;
  const rDays = computeRDays(stats);
  const rModels = aggBy(rDays, 'models', 'model');
  let html = '<div class="hs-section-label">[ USO POR MODELO ]</div>';
  html += stackedChartHtml(rDays, 'models', 'model', (name) => colorForIndex(stats.models, 'model', name));
  html += rModels.length
    ? `<div class="cortex-list">${rModels.map((m) => modelRowHtml(stats, m)).join('')}</div>`
    : emptyStateInner('sin uso en este rango');
  html += rangeFooterHtml();
  return html;
}

// ---------- Pestaña Proyectos ----------
function projectRowHtml(stats, p) {
  const color = colorForIndex(stats.projects, 'project', p.project);
  const name = p.project || '—';
  const sessions = sessionsForProject(name);
  const nSess = sessions.length;
  const expanded = _expandedProject === name;
  let html = `<div class="cortex-list-row cortex-proj-row" data-project="${esc(name)}" style="cursor:${nSess > 0 ? 'pointer' : 'default'}">`
    + `<span class="cortex-swatch" style="background:${color}"></span>`
    + `<span class="cortex-list-name">${esc(name)}</span>`
    + (nSess > 0 ? `<span class="cortex-proj-chevron">${expanded ? '▾' : '▸'}</span>` : '')
    + `<span class="cortex-list-meta">${esc(fmtTok(p.in_tok))} in · ${esc(fmtTok(p.out_tok))} out</span>`
    + `<span class="cortex-list-pct" style="color:${color}">${p.pct.toFixed(1)}%</span>`
    + `</div>`;
  if (expanded && nSess > 0) {
    html += '<div class="cortex-proj-sessions">' + sessions.map((s) => `<div class="cortex-proj-session">`
      + `<span class="cortex-proj-session-dot">↺</span>`
      + `<span class="cortex-proj-session-label">${esc(s.label || '(sesión)')}</span>`
      + `<span class="cortex-proj-session-date">${esc(relDate(s.updated_at))}</span>`
      + `</div>`).join('') + '</div>';
  }
  return html;
}
function renderProyectosTab() {
  if (_stats.status !== 'ok' || !_stats.data) {
    return _stats.status === 'idle' ? loadingHtml('USO POR PROYECTO') : emptyStateHtml('USO POR PROYECTO', stateMessage(_stats));
  }
  const stats = _stats.data;
  const rDays = computeRDays(stats);
  const rProjects = aggBy(rDays, 'projects', 'project');
  let html = '<div class="hs-section-label">[ USO POR PROYECTO ]</div>';
  html += stackedChartHtml(rDays, 'projects', 'project', (name) => colorForIndex(stats.projects, 'project', name));
  html += rProjects.length
    ? `<div class="cortex-list">${rProjects.map((p) => projectRowHtml(stats, p)).join('')}</div>`
    : emptyStateInner('sin uso en este rango');
  html += rangeFooterHtml();
  return html;
}

// ---------- Pestaña Chats (oculta si no hay datos) ----------
function chatsHaveData() {
  return _chats.status === 'ok' && Array.isArray(_chats.data) && _chats.data.length > 0;
}
function renderChatsTab() {
  if (!chatsHaveData()) {
    return emptyStateHtml('CHATS', 'sin conversaciones locales');
  }
  const rChats = rangeFilterChats(_chats.data);
  const modelsList = _stats.status === 'ok' && _stats.data ? _stats.data.models : null;
  let html = '<div class="hs-section-label">[ CHATS ]</div>';
  if (!rChats.length) {
    html += emptyStateInner(_rangeIdx === 3
      ? 'sin conversaciones locales. Abre el app de escritorio de Claude y espera al próximo refresco'
      : 'sin conversaciones en este rango');
  } else {
    const byModel = chatsByModel(rChats);
    html += `<div class="cortex-list">${byModel.map((m) => {
      const color = colorForIndex(modelsList, 'model', m.model);
      return `<div class="cortex-list-row">`
        + `<span class="cortex-swatch" style="background:${color}"></span>`
        + `<span class="cortex-list-name">${esc(prettyModel(m.model))}</span>`
        + `<span class="cortex-list-meta">${m.count}</span>`
        + `<span class="cortex-list-pct" style="color:${color}">${m.pct.toFixed(0)}%</span>`
        + `</div>`;
    }).join('')}</div>`;
    html += '<div class="cortex-divider"></div><div class="cortex-list-caption">recientes</div>';
    html += `<div class="cortex-list">${rChats.slice(0, 20).map((c) => {
      const color = c.model ? colorForIndex(modelsList, 'model', c.model) : null;
      const badge = c.model
        ? `<span class="cortex-chat-badge" style="background:${withAlpha(color, 0.22)};color:${color}">${esc(prettyModel(c.model))}</span>`
        : '';
      return `<div class="cortex-chat-row">`
        + `<span class="cortex-chat-title">${esc(c.title || '(sin título)')}</span>`
        + badge
        + `<span class="cortex-chat-date">${esc(relDate(c.updated_at || c.created_at))}</span>`
        + `</div>`;
    }).join('')}</div>`;
  }
  html += rangeFooterHtml();
  return html;
}

// ---------- Pestaña Cerebro (vivo, vía brain-scan.sh) ----------
function dotListHtml(names) {
  return `<div class="cortex-dot-list">${names.map((n) => `<div class="cortex-dot-row"><span class="cortex-dot">●</span><span class="cortex-dot-name">${esc(n)}</span></div>`).join('')}</div>`;
}
function renderCerebroTab() {
  let html = '<div class="hs-section-label">[ CEREBRO GLOBAL ]</div>';
  html += '<div class="cortex-usage-caption" style="margin-bottom:12px">'
    + 'Guardarraíles + gobernanza + normas de Claude Code en el host. Resumen de salud en vivo — '
    + '<a class="cortex-link" href="https://github.com/unjordi/cortex/blob/main/docs/mapa-cerebro.md" target="_blank" rel="noopener">🗺 mapa completo</a>.'
    + '</div>';

  if (_brain.status === 'ok' && _brain.data) {
    const b = _brain.data;
    const present = Array.isArray(b.present) ? b.present : [];
    const wired = Array.isArray(b.wired) ? b.wired : [];
    const skills = Array.isArray(b.skills) ? b.skills : [];
    html += '<div class="cortex-stat-grid">'
      + statCardHtml('Versión', b.version || '—')
      + statCardHtml('Hooks presentes', String(present.length))
      + statCardHtml('Hooks cableados', String(wired.length))
      + statCardHtml('Skills instalados', String(skills.length))
      + statCardHtml('Normas', b.hasNorms ? 'sí' : 'no')
      + '</div>';
    if (wired.length) html += '<div class="hs-section-label">[ HOOKS CABLEADOS ]</div>' + dotListHtml(wired);
    if (skills.length) html += '<div class="hs-section-label">[ SKILLS INSTALADOS ]</div>' + dotListHtml(skills);
    html += '<div class="cortex-usage-caption" style="margin-top:4px;opacity:0.45">'
      + 'Vista simplificada del estado en vivo (brain-scan.sh) — sin el catálogo completo por-tier del widget de escritorio, ni self-heal/self-update.'
      + '</div>';
  } else if (_brain.status === 'error' || _brain.status === 'degraded') {
    html += emptyStateInner(stateMessage(_brain));
  } else {
    html += '<div class="hoststats-loading">[ ESCANEANDO… ]</div>';
  }
  return html;
}

// ---------- Pestaña Broker (vivo, vía broker-scan.sh + broker-knobs.sh list) ----------
// READ-ONLY por diseño, y la pestaña lo DICE: el endpoint de axon solo invoca `scan` y `list`, nunca
// `set`/`unset` ni arrancar/parar el servicio. Escribir la config del broker desde el navegador sería
// mutación del host, y pararlo cerraría las terminales del usuario — esas acciones viven en el widget
// de ESCRITORIO, que corre como el usuario dueño del .env. Es el mismo límite que esta página ya
// declara para el self-heal/self-update del cerebro.

// Orden y títulos 1:1 con `brokerGrupos`/`brokerGrupoTitulo` del QML (main.qml): las dos caras salen
// del MISMO spec (src/widget-spec/broker-knobs.tsv), así que tampoco su lectura debe divergir.
const BROKER_GRUPOS = [
  ['endpoint', 'Endpoint y contrato con el cliente'],
  ['topes', 'Topes de concurrencia'],
  ['websocket', 'WebSocket: contrapresión y keepalive'],
  ['http', 'Topes del HTTP'],
  ['proceso', 'Proceso'],
];

function fmtBytes(n) {
  if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
}

// El valor EFECTIVO de un knob: `actual` es lo escrito en el .env, y `null` significa "no está puesto"
// ⇒ manda el default del código. Esa distinción se muestra, no se aplana: saber que un valor viene del
// default es justo lo que dice si tocarlo o no.
function knobRowHtml(k) {
  const enDefault = k.actual == null || String(k.actual).length === 0;
  const valor = enDefault ? k.default : k.actual;
  const candado = k.gui === 'lee' ? '<span class="cortex-knob-lock" title="Solo lectura en toda GUI">🔒</span>' : '';
  const marca = enDefault ? '<span class="cortex-knob-tag">default</span>' : '<span class="cortex-knob-tag set">.env</span>';
  const reinicio = k.reinicio ? '<span class="cortex-knob-tag">requiere reinicio</span>' : '';
  let html = '<div class="cortex-knob-row">'
    + `<div class="cortex-knob-head"><span class="cortex-knob-label">${esc(k.etiqueta)}</span>${candado}${marca}${reinicio}</div>`
    + `<div class="cortex-knob-value">${esc(valor == null ? '—' : valor)}</div>`
    + `<div class="cortex-knob-env">${esc(k.env)}</div>`;
  if (k.ayuda) html += `<div class="cortex-knob-help">${esc(k.ayuda)}</div>`;
  if (k.advertencia) html += `<div class="cortex-knob-warn">⚠ ${esc(k.advertencia)}</div>`;
  return html + '</div>';
}

function renderBrokerTab() {
  let html = '<div class="hs-section-label">[ BROKER DE TERMINAL ]</div>';
  html += '<div class="cortex-usage-caption" style="margin-bottom:12px">'
    + 'El servicio del HOST que ejecuta los comandos de esta terminal. Vista de SOLO LECTURA — '
    + 'arrancar/parar el servicio y editar los knobs vive en el widget de escritorio.'
    + '</div>';

  if (_broker.status !== 'ok' || !_broker.data) {
    html += (_broker.status === 'idle' || _broker.status === 'loading')
      ? '<div class="hoststats-loading">[ ESCANEANDO… ]</div>'
      : emptyStateInner(stateMessage(_broker));
    return html;
  }

  const b = _broker.data;
  const u = b.unidad || {};
  const ep = b.endpoint || {};
  const tk = b.token || {};

  html += '<div class="cortex-stat-grid">'
    + statCardHtml('Servicio', u.estado || (u.activa ? 'active' : 'inactive'))
    + statCardHtml('Al arranque', u.habilitada ? 'habilitado' : 'no')
    + statCardHtml('Puerto TCP', ep.escuchando_tcp ? String(ep.puerto == null ? '—' : ep.puerto) : 'no escucha')
    + statCardHtml('Socket unix', ep.socket_existe ? (ep.socket_permisos || 'sí') : 'no existe')
    + statCardHtml('Token', tk.presente ? `${fmtInt(tk.chars)} chars` : 'ausente')
    + statCardHtml('Memoria', fmtBytes(u.memoria_bytes))
    + '</div>';

  html += '<div class="hs-section-label">[ SERVICIO ]</div>';
  html += '<div class="cortex-dot-list">'
    + `<div class="cortex-dot-row"><span class="cortex-dot">●</span><span class="cortex-dot-name">${esc(u.nombre || '—')}</span></div>`
    + (u.desde ? `<div class="cortex-dot-row"><span class="cortex-dot">●</span><span class="cortex-dot-name">activo desde ${esc(u.desde)}</span></div>` : '')
    + `<div class="cortex-dot-row"><span class="cortex-dot">●</span><span class="cortex-dot-name">reinicios: ${esc(u.reinicios == null ? '—' : u.reinicios)}${u.pid ? ' · pid ' + esc(u.pid) : ''}</span></div>`
    + '</div>';

  // El socket unix es EL transporte del cliente contenerizado: esta misma página habla con el broker
  // por ahí, así que su ausencia no es un detalle cosmético.
  html += '<div class="hs-section-label">[ ENDPOINT ]</div>';
  html += '<div class="cortex-dot-list">'
    + `<div class="cortex-dot-row"><span class="cortex-dot">●</span><span class="cortex-dot-name">${esc(ep.socket || '—')}${ep.socket_dueno ? ' · ' + esc(ep.socket_dueno) : ''}</span></div>`
    + `<div class="cortex-dot-row"><span class="cortex-dot">●</span><span class="cortex-dot-name">token en ${esc(tk.archivo || '—')}</span></div>`
    + '</div>';

  if (_brokerKnobs.status === 'ok' && _brokerKnobs.data && Array.isArray(_brokerKnobs.data.knobs)) {
    const knobs = _brokerKnobs.data.knobs;
    html += `<div class="hs-section-label">[ KNOBS · ${esc(_brokerKnobs.data.archivo || '')} ]</div>`;
    for (const [grupo, titulo] of BROKER_GRUPOS) {
      const del = knobs.filter((k) => k && k.grupo === grupo);
      if (!del.length) continue;
      html += `<div class="cortex-knob-group">${esc(titulo)}</div>`;
      html += del.map(knobRowHtml).join('');
    }
  } else if (_brokerKnobs.status === 'error' || _brokerKnobs.status === 'degraded') {
    html += '<div class="hs-section-label">[ KNOBS ]</div>' + emptyStateInner(stateMessage(_brokerKnobs));
  }

  return html;
}

// UNA sola llamada trae las dos mitades (`?knobs=1`): el endpoint devuelve el scan en la raíz y el spec
// de knobs colgado en `knobs`, cada mitad con su propio ok/reason — una puede fallar sin la otra.
async function refreshBroker() {
  try {
    const payload = await fetchJson(ENDPOINTS.broker);
    if (!payload || payload.ok !== true) {
      _broker.status = 'degraded';
      _broker.data = null;
      _broker.message = (payload && (REASON_TEXT[payload.reason] || payload.detail)) || 'sin datos';
    } else {
      _broker.status = 'ok';
      _broker.data = payload.data;
      _broker.message = '';
    }
    const kn = payload && payload.knobs;
    if (kn && kn.ok === true) {
      _brokerKnobs.status = 'ok';
      _brokerKnobs.data = kn.data;
      _brokerKnobs.message = '';
    } else {
      _brokerKnobs.status = 'degraded';
      _brokerKnobs.data = null;
      _brokerKnobs.message = (kn && (REASON_TEXT[kn.reason] || kn.detail)) || 'sin datos';
    }
  } catch (e) {
    _broker.status = 'error';
    _broker.data = null;
    _broker.message = (e && e.message) || 'cortex monitor unreachable';
    _brokerKnobs.status = 'error';
    _brokerKnobs.data = null;
    _brokerKnobs.message = _broker.message;
  }
}

function loadBrokerAndRender() {
  _broker.status = _broker.status === 'idle' ? 'loading' : _broker.status;
  if (_activeTab === 'broker') renderActiveTab();
  if (_brokerLoading) return;
  _brokerLoading = true;
  refreshBroker().then(() => {
    _brokerLoading = false;
    if (_activeTab === 'broker') renderActiveTab();
  });
}

// ---------- Dispatch de render + rail ----------
function renderActiveTab() {
  const body = $('cortex-body');
  if (!body) return;
  let html;
  switch (_activeTab) {
    case 'resumen': html = renderResumenTab(); break;
    case 'modelos': html = renderModelosTab(); break;
    case 'proyectos': html = renderProyectosTab(); break;
    case 'chats': html = renderChatsTab(); break;
    case 'cerebro': html = renderCerebroTab(); break;
    case 'broker': html = renderBrokerTab(); break;
    default: html = renderLimitesTab(); break;
  }
  body.innerHTML = html;
}

function setActiveRailButton(tab) {
  const rail = $('cortex-rail');
  if (!rail) return;
  rail.querySelectorAll('.cortex-rail-btn').forEach((btn) => {
    const active = btn.getAttribute('data-tab') === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function updateChatsTabVisibility() {
  const btn = $('cortex-rail-chats');
  if (!btn) return;
  const has = chatsHaveData();
  btn.hidden = !has;
  if (!has && _activeTab === 'chats') {
    _activeTab = 'limites';
    setActiveRailButton('limites');
  }
}

function loadBrainAndRender() {
  _brain.status = _brain.status === 'idle' ? 'loading' : _brain.status;
  if (_activeTab === 'cerebro') renderActiveTab();
  if (_brainLoading) return;
  _brainLoading = true;
  refreshCache(_brain, ENDPOINTS.brain).then(() => {
    _brainLoading = false;
    if (_activeTab === 'cerebro') renderActiveTab();
  });
}

function selectTab(tab) {
  if (!tab || tab === _activeTab) return;
  _activeTab = tab;
  setActiveRailButton(tab);
  if (tab === 'cerebro') loadBrainAndRender();
  else if (tab === 'broker') loadBrokerAndRender();
  else renderActiveTab();
}

function wireRail() {
  const rail = $('cortex-rail');
  if (!rail) return;
  rail.querySelectorAll('.cortex-rail-btn').forEach((btn) => {
    btn.addEventListener('click', () => selectTab(btn.getAttribute('data-tab')));
  });
}

// Delegación sobre #cortex-body (persiste entre re-renders; los pills/filas SÍ se
// recrean en cada innerHTML) para el rango {hoy·7d·30d·∞} y el expand de Proyectos.
function wireBodyDelegation() {
  if (_bodyDelegationWired) return;
  const body = $('cortex-body');
  if (!body) return;
  body.addEventListener('click', (e) => {
    const pill = e.target.closest && e.target.closest('.cortex-range-pill');
    if (pill) {
      const idx = parseInt(pill.getAttribute('data-range'), 10);
      if (!isNaN(idx) && idx !== _rangeIdx) { _rangeIdx = idx; renderActiveTab(); }
      return;
    }
    const projRow = e.target.closest && e.target.closest('.cortex-proj-row');
    if (projRow) {
      const name = projRow.getAttribute('data-project');
      if (name != null) {
        _expandedProject = _expandedProject === name ? '' : name;
        renderActiveTab();
      }
    }
  });
  _bodyDelegationWired = true;
}

// ---------- Polling ----------
async function poll() {
  if (_inFlight) return;
  _inFlight = true;
  const dot = $('cortex-live-dot');
  try {
    await Promise.all([
      refreshCache(_quota, ENDPOINTS.quota),
      refreshCache(_stats, ENDPOINTS.stats),
      refreshCache(_sessions, ENDPOINTS.sessions),
      refreshCache(_chats, ENDPOINTS.chats),
    ]);
    updateChatsTabVisibility();
    renderActiveTab();
    if (dot) dot.classList.toggle('stale', _quota.status !== 'ok');
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
  wireBodyDelegation();
  if (_activeTab === 'cerebro' && _brain.status === 'idle') loadBrainAndRender();
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

  wireRail();

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
