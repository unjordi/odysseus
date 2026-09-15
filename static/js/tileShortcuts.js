/**
 * tileShortcuts.js — Atajos de teclado estilo Rectangle para el tiling de modales.
 *
 * Cablea un handler `keydown` que mapea un atajo → slot, calcula la geometría
 * con tileSlots.js (PURO, ya probado), la aplica al modal ENFOCADO vía
 * tileManager, cicla al repetir el MISMO atajo, y persiste la geometría por
 * el mismo camino que workspaceState (#29e).
 *
 * La lógica de mapeo/ciclado vive en funciones PURO (sin DOM, sin imports de
 * módulos que toquen el DOM al cargar) para poder testearla con `node --test`
 * (tests/tile_shortcuts.test.mjs). tileManager.js se importa de forma PAREZOSA
 * dentro de aplicarSlot() para no arrastrar `document` al import del módulo.
 *
 * ── Esquema de atajos (verificado libre de conflictos con ui.js) ──
 * Los keydown existentes en ui.js son: Space (toggle hover, línea ~190) y
 * Escape (cerrar, línea ~1255). Ninguno usa Ctrl+Alt, así que el esquema
 * Ctrl+Alt+* no choca. Se elige Ctrl+Alt (no Ctrl solo) para no pisar los
 * atajos nativos del navegador (Ctrl+W, Ctrl+T, Ctrl+L, …).
 *
 *   Ctrl+Alt+←  → mitad izquierda   (cicla 1/2 → 2/3 → 1/3)
 *   Ctrl+Alt+→  → mitad derecha     (cicla 1/2 → 2/3 → 1/3)
 *   Ctrl+Alt+↑  → mitad arriba      (cicla 1/2 → 2/3 → 1/3)
 *   Ctrl+Alt+↓  → mitad abajo       (cicla 1/2 → 2/3 → 1/3)
 *   Ctrl+Alt+U  → cuarto arriba-izq
 *   Ctrl+Alt+I  → cuarto arriba-der
 *   Ctrl+Alt+J  → cuarto abajo-izq
 *   Ctrl+Alt+K  → cuarto abajo-der
 *   Ctrl+Alt+Enter → maximizar
 *   Ctrl+Alt+C  → centrar
 *   Ctrl+Alt+R  → restaurar (geometría libre previa)
 *
 * Ciclado: repetir el MISMO atajo de mitad cicla entre 1/2, 2/3 y 1/3
 * (FRACCIONES de tileSlots.js). Los cuartos NO ciclan (siempre 1/2), igual
 * que en Rectangle. Maximizar/centrar/restaurar tampoco ciclan.
 */

import { calcular, estadoInicial, esSlot } from './tileSlots.js';
import WorkspaceState from './workspaceState.js';

// ── Mapeo atajo → slot (PURO, testable) ──
const ATAJOS = {
  'ctrl+alt+arrowleft':  'left',
  'ctrl+alt+arrowright': 'right',
  'ctrl+alt+arrowup':    'top',
  'ctrl+alt+arrowdown':  'bottom',
  'ctrl+alt+u':          'top-left',
  'ctrl+alt+i':          'top-right',
  'ctrl+alt+j':          'bottom-left',
  'ctrl+alt+k':          'bottom-right',
  'ctrl+alt+enter':      'maximize',
  'ctrl+alt+c':          'center',
  'ctrl+alt+r':          'restore',
};

export function claveDeEvento(e) {
  if (!e) return null;
  if (!e.ctrlKey || !e.altKey) return null;
  if (e.metaKey) return null;
  const key = (e.key || '').toLowerCase();
  const normalizada = 'ctrl+alt+' + key;
  return ATAJOS[normalizada] ? normalizada : null;
}

export function slotParaClave(clave) {
  if (!clave) return null;
  return ATAJOS[clave] || null;
}

export function atajoDeEvento(e) {
  const clave = claveDeEvento(e);
  if (!clave) return null;
  const slot = slotParaClave(clave);
  if (!slot || !esSlot(slot)) return null;
  return { slot };
}

// ── Estado de ciclado por modal (PURO) ──
const _tileState = new WeakMap();
function _estadoPara(content) {
  if (!_tileState.has(content)) _tileState.set(content, estadoInicial());
  return _tileState.get(content);
}

// ── DOM: modal enfocado ──
export function modalEnfocado() {
  const modals = Array.from(document.querySelectorAll('.modal, .research-overlay'))
    .filter((m) => {
      if (!m || m.classList.contains('hidden') || m.classList.contains('modal-minimized')) return false;
      const cs = getComputedStyle(m);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      return true;
    });
  if (!modals.length) return null;
  modals.sort((a, b) => {
    const za = parseInt(getComputedStyle(a).zIndex, 10) || 0;
    const zb = parseInt(getComputedStyle(b).zIndex, 10) || 0;
    return zb - za;
  });
  return modals[0];
}

function _contentDe(modal) {
  if (!modal) return null;
  return (modal.querySelector && modal.querySelector('.modal-content, .research-pane')) || modal;
}

function _areaUtil() {
  const sidebar = document.getElementById('sidebar');
  const rail = document.querySelector('.icon-rail') || document.querySelector('#icon-rail');
  let leftEdge = 0;
  const sb = sidebar?.getBoundingClientRect();
  if (sb && sb.right > 0 && !sidebar.classList.contains('hidden')) leftEdge = Math.max(leftEdge, sb.right);
  const rr = rail?.getBoundingClientRect();
  if (rr && rr.right > 0) leftEdge = Math.max(leftEdge, rr.right);
  // #29c/H1: restar las regiones reservadas por borde (edgeRegions emite
  // --reserved-<edge> en <body>) para que una ventana tilada no se meta DEBAJO
  // de un widget acoplado (p. ej. hostStats docked abajo). Se leen del CSS var
  // para no acoplar el tiling a la instancia JS de edgeRegions.
  const cs = getComputedStyle(document.body);
  const reservedTop = parseFloat(cs.getPropertyValue('--reserved-top')) || 0;
  const reservedBottom = parseFloat(cs.getPropertyValue('--reserved-bottom')) || 0;
  const left = leftEdge + 4;
  const top = 4 + reservedTop;
  const width = Math.max(0, window.innerWidth - left - 4);
  const height = Math.max(0, window.innerHeight - 8 - reservedTop - reservedBottom);
  return { left, top, width, height };
}

export function aplicarSlot(slot, modalOverride = null) {
  if (!esSlot(slot)) return false;
  const modal = modalOverride || modalEnfocado();
  if (!modal) return false;
  const content = _contentDe(modal);
  if (!content) return false;

  const area = _areaUtil();
  const rectActual = content.getBoundingClientRect();
  const estado = _estadoPara(content);

  const { rect, estado: estadoNuevo } = calcular(estado, slot, area, rectActual);
  if (!rect) return false;

  _tileState.set(content, estadoNuevo);

  // Aplicar la geometría al .modal-content. Importamos tileManager de forma
  // PAREZOSA para no arrastrar `document` al import del módulo (el test de
  // lógica pura no carga el DOM). snapModalToZone ya hace _applySnap.
  let snapFn = null;
  try { snapFn = require_tileManager?.snapModalToZone; } catch (_) {}
  if (typeof snapFn === 'function') {
    try { snapFn(modal, { name: slot, rect }); }
    catch (err) { console.warn('tileShortcuts: snapModalToZone falló', err); _applyManual(content, rect); }
  } else {
    _applyManual(content, rect);
  }

  // Persistir la geometría por el mismo camino que workspaceState (#29e):
  // setGeometry(id, {x,y,w,h}) — la firma real de workspaceState.js.
  try {
    const id = modal.id;
    if (id && typeof WorkspaceState.setGeometry === 'function') {
      WorkspaceState.setGeometry(id, { x: rect.left, y: rect.top, w: rect.width, h: rect.height });
    }
  } catch (err) {
    console.warn('tileShortcuts: persistir tile falló', err);
  }

  return true;
}

function _applyManual(content, rect) {
  content.style.setProperty('position', 'fixed', 'important');
  content.style.setProperty('left', rect.left + 'px', 'important');
  content.style.setProperty('top', rect.top + 'px', 'important');
  content.style.setProperty('width', rect.width + 'px', 'important');
  content.style.setProperty('height', rect.height + 'px', 'important');
  content.style.setProperty('max-height', rect.height + 'px', 'important');
}

// Import perezoso de tileManager (evita cargar `document` al importar este
// módulo en un entorno sin DOM, como el test de node).
let _tileManager = null;
function require_tileManager() {
  if (_tileManager) return _tileManager;
  // En el browser, import() dinámico; en node (test) no se llama nunca porque
  // aplicarSlot no se invoca sin DOM.
  return import('./tileManager.js').then((m) => { _tileManager = m; return m; });
}

function _onKeydown(e) {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  // NOTA: NO se corta por ancho de viewport. El tiling debe operar también en
  // móvil — tileSlots.js trae las FRACCIONES ½/⅔/⅓ diseñadas justo para partir
  // pantallas chicas. (Un guard `innerWidth <= 768 return` metido sin
  // autorización apagaba el tiling en teléfono; revertido a propósito. El área
  // se calcula desde innerWidth/innerHeight reales en _areaUtil(), así que se
  // adapta a cualquier ancho sin asumir escritorio.)
  const atajo = atajoDeEvento(e);
  if (!atajo) return;
  e.preventDefault();
  e.stopPropagation();
  aplicarSlot(atajo.slot);
}

// ── Superficie VISIBLE del tiling (#29d) ────────────────────────────────────
// Hasta ahora el tiling solo tenía atajos de teclado INVISIBLES. Esto agrega una
// afordancia visible en el header del modal: un botón "mosaico" que abre un mini
// mapa de zonas; cada zona llama al MISMO aplicarSlot() (núcleo puro ya probado
// de tileSlots.js). Funciona en escritorio y en móvil (donde no hay teclado, es
// la ÚNICA vía de tiling) — las fracciones ½/⅔/⅓ parten pantallas chicas.

const _SNAP_ZONES = [
  { slot: 'top-left',     label: 'Arriba izquierda', glyph: '◰' },
  { slot: 'top',          label: 'Mitad superior',   glyph: '▔' },
  { slot: 'top-right',    label: 'Arriba derecha',   glyph: '◳' },
  { slot: 'left',         label: 'Mitad izquierda',  glyph: '▏' },
  { slot: 'maximize',     label: 'Maximizar',        glyph: '▢' },
  { slot: 'right',        label: 'Mitad derecha',    glyph: '▕' },
  { slot: 'bottom-left',  label: 'Abajo izquierda',  glyph: '◱' },
  { slot: 'bottom',       label: 'Mitad inferior',   glyph: '▁' },
  { slot: 'bottom-right', label: 'Abajo derecha',    glyph: '◲' },
  { slot: 'center',       label: 'Centrar',          glyph: '◇' },
  { slot: 'restore',      label: 'Restaurar',        glyph: '⤢' },
];

let _snapStylesInjected = false;
function _ensureSnapStyles() {
  if (_snapStylesInjected || typeof document === 'undefined') return;
  _snapStylesInjected = true;
  const style = document.createElement('style');
  style.id = 'tile-snap-styles';
  style.textContent = `
    .modal-tile-btn { flex-shrink:0; background:none; border:none; color:inherit;
      cursor:pointer; padding:4px; line-height:0; opacity:0.7; border-radius:4px; }
    .modal-tile-btn:hover { opacity:1; background:color-mix(in srgb, currentColor 12%, transparent); }
    .tile-snap-popover { position:fixed; z-index:10040; padding:8px;
      background:var(--surface-raised, var(--bg-elevated, #1e1e24));
      border:1px solid color-mix(in srgb, currentColor 18%, transparent);
      border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,0.35);
      display:grid; grid-template-columns:repeat(3, 34px); gap:6px; }
    .tile-snap-popover .wide { grid-column:1 / -1; width:auto; }
    .tile-snap-cell { width:34px; height:34px; display:flex; align-items:center;
      justify-content:center; font-size:16px; cursor:pointer; border-radius:7px;
      border:1px solid color-mix(in srgb, currentColor 16%, transparent);
      background:color-mix(in srgb, currentColor 5%, transparent); color:inherit; }
    .tile-snap-cell.wide { height:28px; font-size:13px; gap:6px; }
    .tile-snap-cell:hover { background:var(--accent-primary, #60a5fa); color:#fff;
      border-color:transparent; }
    @media (max-width:768px) {
      .tile-snap-popover { grid-template-columns:repeat(3, 44px); gap:8px; padding:10px; }
      .tile-snap-cell { width:44px; height:44px; font-size:19px; }
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

let _openPopover = null;
function _closePopover() {
  if (_openPopover) { _openPopover.remove(); _openPopover = null; }
  document.removeEventListener('pointerdown', _onDocDown, true);
  document.removeEventListener('keydown', _onPopoverEsc, true);
}
function _onDocDown(e) {
  if (_openPopover && !_openPopover.contains(e.target)
      && !(e.target.closest && e.target.closest('.modal-tile-btn'))) {
    _closePopover();
  }
}
function _onPopoverEsc(e) { if (e.key === 'Escape') { e.stopPropagation(); _closePopover(); } }

function _openSnapPopover(btn, modal) {
  _ensureSnapStyles();
  if (_openPopover) { _closePopover(); return; }
  const pop = document.createElement('div');
  pop.className = 'tile-snap-popover';
  for (const z of _SNAP_ZONES) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'tile-snap-cell' + ((z.slot === 'center' || z.slot === 'restore') ? ' wide' : '');
    cell.title = z.label;
    cell.setAttribute('aria-label', z.label);
    cell.textContent = (z.slot === 'center' || z.slot === 'restore')
      ? `${z.glyph}  ${z.label}` : z.glyph;
    cell.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      aplicarSlot(z.slot, modal);
      _closePopover();
    });
    pop.appendChild(cell);
  }
  document.body.appendChild(pop);
  // Posicionar bajo el botón, recortando al viewport.
  const r = btn.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - pw - 8);
  left = Math.max(8, left);
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  _openPopover = pop;
  document.addEventListener('pointerdown', _onDocDown, true);
  document.addEventListener('keydown', _onPopoverEsc, true);
}

/**
 * Inyecta el botón VISIBLE de mosaico en el header de un modal (#29d).
 * Idempotente. Se coloca a la izquierda del botón minimizar/cerrar.
 */
export function injectSnapControls(modal) {
  if (!modal || !modal.querySelector) return;
  const header = modal.querySelector('.modal-header');
  if (!header) return;
  if (header.querySelector('.modal-tile-btn')) return;
  _ensureSnapStyles();
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'modal-tile-btn';
  btn.title = 'Acomodar en mosaico (tiling)';
  btn.setAttribute('aria-label', 'Acomodar ventana en mosaico');
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>';
  btn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    _openSnapPopover(btn, modal);
  });
  // Colocar antes del minimizar (o del cerrar), para que el par _/X quede a la
  // derecha. margin-left:auto empuja el grupo de botones al borde derecho.
  const anchor = header.querySelector('.modal-minimize-btn, .minimize-btn, [data-minimize], .close-btn, .modal-close');
  if (anchor && anchor.parentNode) {
    btn.style.marginLeft = 'auto';
    anchor.parentNode.insertBefore(btn, anchor);
    btn.style.marginLeft = '';
    // Ya no somos el primero en empujar: dejar que el minimizar mantenga su auto.
  } else {
    btn.style.marginLeft = 'auto';
    header.appendChild(btn);
  }
}

let _registered = false;
export function init() {
  if (_registered) return;
  _registered = true;
  document.addEventListener('keydown', _onKeydown, true);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}

export { ATAJOS };
export default { init, aplicarSlot, injectSnapControls, modalEnfocado, atajoDeEvento, claveDeEvento, slotParaClave, ATAJOS };
