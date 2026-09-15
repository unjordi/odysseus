/**
 * modalSwitcherUI.js — Cableado DOM del switcher de instancias abiertas (#29f).
 *
 * El NÚCLEO puro (modalSwitcher.js: buildSwitcher/nextInSwitcher/prevInSwitcher,
 * ya probado con node --test) decide el ORDEN, cuál está activo y la navegación
 * con wrap. Este módulo solo lo cablea al DOM: lee las instancias abiertas de
 * workspaceState, pinta una afordancia VISIBLE (un botón flotante + lista) para
 * cambiar entre widgets/terminales, y al elegir uno lo trae al frente vía
 * modalManager.focusInstance. Pensado sobre todo para MÓVIL, donde los modales
 * van a fullscreen de uno en uno y hacía falta un task-switcher — pero también
 * sirve en escritorio (atajos Ctrl+Alt+PageUp/PageDown para ciclar).
 *
 * Se mantiene PEQUEÑO y defensivo: si algo falta, no lanza; simplemente no
 * muestra el switcher (con <2 instancias abiertas no tiene sentido).
 */

import { buildSwitcher, nextInSwitcher, prevInSwitcher } from './modalSwitcher.js';
import WorkspaceState from './workspaceState.js';
import { labelFor, focusInstance, frontmostInstanceId, openToolWindows } from './modalManager.js';

let _fab = null;         // botón flotante
let _panel = null;       // lista desplegable
let _stylesInjected = false;
let _rafPending = false;

function _ensureStyles() {
  if (_stylesInjected || typeof document === 'undefined') return;
  _stylesInjected = true;
  const style = document.createElement('style');
  style.id = 'modal-switcher-styles';
  style.textContent = `
    #modal-switcher-fab {
      position:fixed; left:50%; transform:translateX(-50%);
      bottom:calc(12px + env(safe-area-inset-bottom, 0px));
      z-index:10035; display:none; align-items:center; gap:8px;
      padding:8px 14px; border-radius:999px; cursor:pointer;
      background:var(--surface-raised, var(--bg-elevated, #23232b));
      color:var(--text-primary, #e8e8ea);
      border:1px solid color-mix(in srgb, currentColor 18%, transparent);
      box-shadow:0 6px 22px rgba(0,0,0,0.32); font:inherit; font-size:13px;
    }
    #modal-switcher-fab.visible { display:flex; }
    #modal-switcher-fab .msw-count {
      min-width:18px; height:18px; padding:0 5px; border-radius:9px;
      background:var(--accent-primary, #60a5fa); color:#fff; font-size:11px;
      font-weight:600; display:inline-flex; align-items:center; justify-content:center;
    }
    #modal-switcher-panel {
      position:fixed; left:50%; transform:translateX(-50%);
      bottom:calc(58px + env(safe-area-inset-bottom, 0px));
      z-index:10036; display:none; flex-direction:column; gap:2px; padding:8px;
      min-width:min(280px, 90vw); max-height:60vh; overflow-y:auto;
      background:var(--surface-raised, var(--bg-elevated, #23232b));
      color:var(--text-primary, #e8e8ea);
      border:1px solid color-mix(in srgb, currentColor 18%, transparent);
      border-radius:14px; box-shadow:0 10px 34px rgba(0,0,0,0.4);
    }
    #modal-switcher-panel.visible { display:flex; }
    #modal-switcher-panel .msw-head {
      display:flex; align-items:center; justify-content:space-between;
      padding:2px 6px 6px; font-size:12px; opacity:0.7; }
    #modal-switcher-panel .msw-nav { display:flex; gap:4px; }
    #modal-switcher-panel .msw-nav button {
      width:26px; height:26px; border-radius:6px; cursor:pointer; color:inherit;
      background:color-mix(in srgb, currentColor 8%, transparent);
      border:1px solid color-mix(in srgb, currentColor 16%, transparent); }
    #modal-switcher-panel .msw-item {
      display:flex; align-items:center; gap:10px; padding:10px 12px;
      border-radius:9px; cursor:pointer; border:1px solid transparent;
      background:none; color:inherit; font:inherit; font-size:14px; text-align:left; }
    #modal-switcher-panel .msw-item:hover { background:color-mix(in srgb, currentColor 10%, transparent); }
    #modal-switcher-panel .msw-item.active {
      background:color-mix(in srgb, var(--accent-primary, #60a5fa) 20%, transparent);
      border-color:color-mix(in srgb, var(--accent-primary, #60a5fa) 45%, transparent); }
    #modal-switcher-panel .msw-item .msw-dot {
      width:8px; height:8px; border-radius:50%; flex-shrink:0;
      background:var(--accent-primary, #60a5fa); opacity:0; }
    #modal-switcher-panel .msw-item.active .msw-dot { opacity:1; }
    #modal-switcher-panel .msw-item.min { opacity:0.6; font-style:italic; }
  `;
  (document.head || document.documentElement).appendChild(style);
}

// FUENTE de la lista del switcher: las ventanas-herramienta REALMENTE abiertas o
// minimizadas, leídas del DOM vivo por modalManager.openToolWindows (#29f). Antes
// se leía workspaceState.openInstances(), que es la persistencia para RESTORE:
// listaba fantasmas ("Document"/id virtual doc-panel, la barra docked de Host
// Stats) y OMITÍA Cortex y las terminales (no están en _AUTO_WIRE). El DOM es la
// única fuente que refleja lo que el usuario puede enfocar ahora.
function _openList() { return openToolWindows ? openToolWindows() : []; }

function _labelsMap(list) {
  const map = {};
  for (const rec of list) {
    const moduleId = (rec && (rec.module || rec.id)) || '';
    if (moduleId && !(moduleId in map)) map[moduleId] = labelFor(moduleId);
  }
  return map;
}

// Etiqueta a mostrar: el título vivo del header del modal (incluye p. ej.
// "Terminal 2") si existe; si no, la del núcleo puro.
function _displayLabel(entry) {
  try {
    const modal = document.getElementById(entry.id);
    const header = modal && modal.querySelector && modal.querySelector('.modal-header');
    if (header) {
      const clone = header.cloneNode(true);
      clone.querySelectorAll('button, input, select, svg').forEach((n) => n.remove());
      const t = (clone.textContent || '').trim().split('\n')[0].trim();
      if (t) return t;
    }
  } catch (_) {}
  return entry.label;
}

function _currentView() {
  const list = _openList();
  const labels = _labelsMap(list);
  const activeId = frontmostInstanceId();
  return { view: buildSwitcher(list, labels, activeId), activeId };
}

function _closePanel() {
  if (_panel) _panel.classList.remove('visible');
  document.removeEventListener('pointerdown', _onDocDown, true);
  document.removeEventListener('keydown', _onPanelEsc, true);
}
function _onDocDown(e) {
  if (_panel && _panel.classList.contains('visible')
      && !_panel.contains(e.target) && e.target !== _fab && !(_fab && _fab.contains(e.target))) {
    _closePanel();
  }
}
function _onPanelEsc(e) { if (e.key === 'Escape') { e.stopPropagation(); _closePanel(); } }

function _renderPanel() {
  const { view, activeId } = _currentView();
  _panel.textContent = '';

  const head = document.createElement('div');
  head.className = 'msw-head';
  const title = document.createElement('span');
  title.textContent = 'Ventanas abiertas';
  const nav = document.createElement('div');
  nav.className = 'msw-nav';
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button'; prevBtn.title = 'Anterior (Ctrl+Alt+RePág)'; prevBtn.textContent = '‹';
  prevBtn.addEventListener('click', (e) => { e.stopPropagation(); _cycle(-1); });
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button'; nextBtn.title = 'Siguiente (Ctrl+Alt+AvPág)'; nextBtn.textContent = '›';
  nextBtn.addEventListener('click', (e) => { e.stopPropagation(); _cycle(1); });
  nav.appendChild(prevBtn); nav.appendChild(nextBtn);
  head.appendChild(title); head.appendChild(nav);
  _panel.appendChild(head);

  for (const entry of view) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'msw-item' + (entry.active ? ' active' : '') + (entry.minimized ? ' min' : '');
    const dot = document.createElement('span');
    dot.className = 'msw-dot';
    const lbl = document.createElement('span');
    lbl.textContent = _displayLabel(entry) + (entry.minimized ? ' (minimizado)' : '');
    item.appendChild(dot); item.appendChild(lbl);
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      focusInstance(entry.id);
      _closePanel();
      requestAnimationFrame(render);
    });
    _panel.appendChild(item);
  }
}

function _togglePanel() {
  if (!_panel) return;
  if (_panel.classList.contains('visible')) { _closePanel(); return; }
  _renderPanel();
  _panel.classList.add('visible');
  document.addEventListener('pointerdown', _onDocDown, true);
  document.addEventListener('keydown', _onPanelEsc, true);
}

// Ciclar al siguiente/anterior (dir=+1/-1) reusando el núcleo puro.
function _cycle(dir) {
  const { view, activeId } = _currentView();
  const nextId = dir >= 0 ? nextInSwitcher(view, activeId) : prevInSwitcher(view, activeId);
  if (nextId) {
    focusInstance(nextId);
    if (_panel && _panel.classList.contains('visible')) _renderPanel();
    requestAnimationFrame(render);
  }
}

function _ensureEls() {
  if (_fab) return;
  _ensureStyles();
  _fab = document.createElement('button');
  _fab.id = 'modal-switcher-fab';
  _fab.type = 'button';
  _fab.setAttribute('aria-label', 'Cambiar de ventana');
  _fab.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M8 20h11a2 2 0 0 0 2-2V9"/></svg><span class="msw-label">Ventanas</span><span class="msw-count">0</span>';
  _fab.addEventListener('click', (e) => { e.stopPropagation(); _togglePanel(); });
  _panel = document.createElement('div');
  _panel.id = 'modal-switcher-panel';
  document.body.appendChild(_fab);
  document.body.appendChild(_panel);
}

// Muestra/oculta el FAB según el número de instancias abiertas y refresca el
// contador. Con <2 no tiene sentido un switcher.
export function render() {
  _ensureEls();
  const list = _openList();
  const n = list.length;
  const countEl = _fab.querySelector('.msw-count');
  if (countEl) countEl.textContent = String(n);
  if (n >= 2) _fab.classList.add('visible');
  else { _fab.classList.remove('visible'); _closePanel(); }
  if (_panel && _panel.classList.contains('visible')) _renderPanel();
}

function _scheduleRender() {
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => { _rafPending = false; try { render(); } catch (_) {} });
}

function _onKeydown(e) {
  if (!e.ctrlKey || !e.altKey || e.metaKey) return;
  const k = (e.key || '');
  if (k === 'PageDown') { e.preventDefault(); e.stopPropagation(); _cycle(1); }
  else if (k === 'PageUp') { e.preventDefault(); e.stopPropagation(); _cycle(-1); }
}

let _inited = false;
export function init() {
  if (_inited || typeof document === 'undefined') return;
  _inited = true;
  _ensureEls();
  render();
  try { WorkspaceState.subscribe && WorkspaceState.subscribe(_scheduleRender); } catch (_) {}
  window.addEventListener('odysseus:modal-opened', _scheduleRender);
  document.addEventListener('keydown', _onKeydown, true);
  // Fallback: el estado del workspace también cambia por caminos que no
  // notifican (cerrar por swipe, etc.); un sondeo ligero mantiene el FAB al día.
  setInterval(() => { try { render(); } catch (_) {} }, 1500);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}

export default { init, render };
