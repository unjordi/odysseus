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

export function aplicarSlot(slot) {
  if (!esSlot(slot)) return false;
  const modal = modalEnfocado();
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
  const atajo = atajoDeEvento(e);
  if (!atajo) return;
  e.preventDefault();
  e.stopPropagation();
  aplicarSlot(atajo.slot);
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
export default { init, aplicarSlot, modalEnfocado, atajoDeEvento, claveDeEvento, slotParaClave, ATAJOS };
