// ============================================
// AXON CONFIG panel — configura el cerebro (modelo local) y el modo
// (build/plan) de axon desde la UI, sin escarbar env vars ni tocar la
// terminal. Pedido: "un widget para configurar el comportamiento del axon
// para que no lo tengas que hacer tú ni escarbar".
//
// Self-contained (mismo patrón que hostStats.js): un endpoint mismo-origen
// (GET/POST /api/axon/config — axon es el MAIN CAR en :7001, no lo proxea a
// Odysseus), su propio DOM, su propio wiring de apertura. El rail lo abre
// INDIRECTO vía _railToolMap (app.js): rail-axoncfg -> tool-axoncfg-btn.click()
// -> el listener de abajo. Un addEventListener crudo en el rail NO basta
// (gotcha ya vivido con este mismo fork) — hay que colgarse del botón
// tool-*-btn que el mapa realmente dispara.
// ============================================

import { makeWindowDraggable } from './windowDrag.js';

const MODAL_ID = 'axoncfg-modal';
const ENDPOINT = '/api/axon/config';

const $ = (id) => document.getElementById(id);

function fmtSize(bytes) {
  if (typeof bytes !== 'number' || !isFinite(bytes) || bytes <= 0) return '';
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}

// Etiqueta legible de un modelo en el <select>: nombre + params + tamaño +
// una nota si NO cabe en VRAM (offload) o no cabe ni con offload (no elegible).
function modelLabel(m) {
  const bits = [];
  if (m.engine === 'freetoken') bits.push('FreeToken · MoE');
  if (m.params) bits.push(`${m.params}B`);
  const size = fmtSize(m.sizeBytes);
  if (size) bits.push(size);
  if (!m.fits && m.runnable) bits.push('offload');
  if (!m.runnable) bits.push('no cabe');
  return bits.length ? `${m.name} (${bits.join(' · ')})` : m.name;
}

function setStatus(msg, isError) {
  const el = $('axoncfg-status');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('axoncfg-status-error', !!isError);
}

// Pinta el snapshot (de GET o de la respuesta de POST — mismo shape) en los
// selectores. Nunca dispara el 'change' de los selects que rellena (evita un
// loop de apply() al re-renderizar tras un apply exitoso).
function render(snap) {
  const modelSel = $('axoncfg-model');
  const modeSel = $('axoncfg-mode');
  const ollamaLine = $('axoncfg-ollama');
  if (!modelSel || !modeSel) return;

  modelSel.innerHTML = '';
  const models = Array.isArray(snap.models) ? snap.models : [];
  if (models.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = snap.ollamaUp ? 'sin modelos instalados' : 'ollama no responde';
    modelSel.appendChild(opt);
    modelSel.disabled = true;
  } else {
    modelSel.disabled = false;
    if (!snap.hasLocal) {
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '(frontier-only — ninguno activo)';
      none.selected = true;
      modelSel.appendChild(none);
    }
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = modelLabel(m);
      if (!m.runnable) opt.disabled = true; // no cabe ni con offload: no ofrecerlo como elegible
      if (m.name === snap.cerebro) opt.selected = true;
      modelSel.appendChild(opt);
    }
  }

  modeSel.value = snap.mode === 'plan' ? 'plan' : 'build';

  if (ollamaLine) {
    const ollamaModels = models.filter((m) => m.engine !== 'freetoken').length;
    const ftModels = models.filter((m) => m.engine === 'freetoken').length;
    const parts = [snap.ollamaUp ? `ollama activo · ${ollamaModels} modelo(s)` : 'ollama no responde'];
    if (ftModels > 0) parts.push(`FreeToken activo · ${ftModels} modelo(s)`);
    ollamaLine.textContent = parts.join(' · ');
  }
}

async function load() {
  setStatus('cargando…');
  try {
    const r = await fetch(ENDPOINT, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const snap = await r.json();
    render(snap);
    setStatus('');
  } catch (e) {
    setStatus('no se pudo leer la config de axon: ' + (e && e.message || e), true);
  }
}

async function apply(patch) {
  setStatus('aplicando…');
  const modelSel = $('axoncfg-model');
  const modeSel = $('axoncfg-mode');
  if (modelSel) modelSel.disabled = true;
  if (modeSel) modeSel.disabled = true;
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) {
      throw new Error((data && data.error) || ('HTTP ' + r.status));
    }
    render(data);
    setStatus('✓ aplicado');
    setTimeout(() => setStatus(''), 2000);
  } catch (e) {
    setStatus('✗ ' + (e && e.message || e), true);
    load(); // re-sincroniza los selectores con el estado REAL (el POST pudo fallar a medias)
  } finally {
    if (modelSel) modelSel.disabled = false;
    if (modeSel) modeSel.disabled = false;
  }
}

function isOpen() {
  const m = $(MODAL_ID);
  return m && !m.classList.contains('hidden');
}

function open() {
  const m = $(MODAL_ID);
  if (!m) return;
  if (window.Modals && window.Modals.isMinimized && window.Modals.isMinimized(MODAL_ID)) {
    window.Modals.restore(MODAL_ID);
  }
  m.classList.remove('hidden');
  load();
}

function close() {
  const m = $(MODAL_ID);
  if (m) m.classList.add('hidden');
}

function toggle() {
  if (isOpen()) close(); else open();
}

function init() {
  // El rail abre esto INDIRECTO: rail-axoncfg -> _railToolMap (app.js) ->
  // tool-axoncfg-btn.click() -> este listener. Colgarse del rail directo NO
  // basta (ver comentario de cabecera).
  const toolBtn = $('tool-axoncfg-btn');
  if (toolBtn) toolBtn.addEventListener('click', toggle);
  const closeBtn = $('close-axoncfg-modal');
  if (closeBtn) closeBtn.addEventListener('click', close);

  const modelSel = $('axoncfg-model');
  if (modelSel) modelSel.addEventListener('change', () => {
    if (modelSel.value) apply({ model: modelSel.value });
  });
  const modeSel = $('axoncfg-mode');
  if (modeSel) modeSel.addEventListener('change', () => apply({ mode: modeSel.value }));

  const modal = $(MODAL_ID);
  if (modal) {
    const content = modal.querySelector('.modal-content');
    const header = modal.querySelector('.modal-header');
    if (content && header) makeWindowDraggable(modal, { content, header });
  }

  window.axonConfig = { open, close, toggle };
}

if (document.readyState !== 'loading') init();
else document.addEventListener('DOMContentLoaded', init);

export default { open, close, toggle };
