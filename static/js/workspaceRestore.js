// static/js/workspaceRestore.js
//
// The boot half of the shell state (roadmap #29(e)): read what the user left
// open and put it back. "Recuerda dónde lo dejaste" and "un reload o un
// signout/signin lo devuelve a su sitio" are not two features — they are one
// read of WorkspaceState at startup, because the state lives on the server
// (per user), not in a browser that gets wiped on logout.
//
// HOW it reopens: through each tool's OWN launcher button, the same
// indirection the icon rail already uses (app.js's `_railToolMap` forwards a
// rail click to the hidden `tool-*-btn`). No tool needs to expose a special
// "restore" entry point, and a tool that changes how it opens keeps working
// here for free.
//
// WHAT IT DOES NOT DO YET (next slice, on purpose):
//   · geometry — position/size are recorded in the schema but not restored;
//     ~20 windows with different overflow/dock models need their own pass.
//   · minimized chips — putting a chip back means opening the modal and then
//     minimizing it, which flashes the window on every load. The minimized
//     flag IS persisted, so the next slice can restore chips properly.

import * as Modals from './modalManager.js';
import WorkspaceState from './workspaceState.js';

// #29(e) RESTORE — aplicar la geometría persistida (rec.geom = {x,y,w,h}) al
// .modal-content de una ventana ya reabierta, clampeada al viewport. Reusa el
// mismo camino que el tiling (position:fixed + left/top/width/height sobre el
// content). Una geom ausente/inválida → no toca nada (cero regresión).
function _contentDe(modal) {
  if (!modal) return null;
  return modal.querySelector('.modal-content') || modal;
}

function _clampGeom(geom) {
  const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
  const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
  const MARGIN = 8;
  let { x, y, w, h } = geom;
  w = Math.max(120, Math.min(w, vw - MARGIN * 2));
  h = Math.max(80, Math.min(h, vh - MARGIN * 2));
  x = Math.max(MARGIN, Math.min(x, vw - w - MARGIN));
  y = Math.max(MARGIN, Math.min(y, vh - h - MARGIN));
  return { x, y, w, h };
}

function _applyGeom(modal, geom) {
  if (!geom) return false;
  const { x, y, w, h } = geom;
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return false;
  const content = _contentDe(modal);
  if (!content || !content.style) return false;
  const c = _clampGeom({ x, y, w, h });
  content.style.setProperty('position', 'fixed', 'important');
  content.style.setProperty('left', c.x + 'px', 'important');
  content.style.setProperty('top', c.y + 'px', 'important');
  content.style.setProperty('width', c.w + 'px', 'important');
  content.style.setProperty('height', c.h + 'px', 'important');
  content.style.setProperty('max-height', c.h + 'px', 'important');
  return true;
}

// Transient popovers that happen to be modal-shaped. Reopening these on every
// load would be noise, not restoration.
const NEVER_RESTORE = new Set([
  'ge-shortcuts-modal',
  'custom-preset-modal',
]);

const STAGGER_MS = 150;

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function _isVisible(el) {
  if (!el) return false;
  if (el.classList.contains('hidden') || el.classList.contains('modal-minimized')) return false;
  try { return getComputedStyle(el).display !== 'none'; } catch (_) { return true; }
}

function _launcherButton(id) {
  const wire = Modals.launcherFor(id);
  if (!wire) return null;
  return (wire.sidebar && document.getElementById(wire.sidebar))
      || (wire.rail && document.getElementById(wire.rail))
      || null;
}

/**
 * Reopen everything the user had open, oldest-first so the last window they
 * raised ends up on top. Idempotent: anything already visible is skipped, so
 * a deep-link route opener that ran first is never toggled shut.
 *
 * Always arms tracking at the end — including on failure. A restore that threw
 * must not leave the shell recording nothing for the rest of the session.
 */
export async function restoreWorkspace() {
  try {
    await WorkspaceState.ready();
    for (const rec of WorkspaceState.openInstances()) {
      if (NEVER_RESTORE.has(rec.id)) continue;
      const modal = document.getElementById(rec.id);
      if (_isVisible(modal)) continue;
      const btn = _launcherButton(rec.id);
      if (!btn) continue;                     // no launcher — not restorable yet
      try { btn.click(); } catch (e) { console.warn('[workspaceRestore] could not reopen', rec.id, e); }
      await _sleep(STAGGER_MS);
      // #29(e) RESTORE — tras reabrir, aplicar la geometría persistida y, si la
      // ventana estaba minimizada, devolverla a su chip. Todo never-throws:
      // una geom ausente/inválida o un minimize fallido no rompen el restore.
      try {
        const live = document.getElementById(rec.id);
        if (live) {
          if (rec.geom) _applyGeom(live, rec.geom);
          if (rec.minimized && typeof Modals.minimize === 'function') {
            Modals.minimize(rec.id);
          }
        }
      } catch (e) { console.warn('[workspaceRestore] geom/minimize restore failed', rec.id, e); }
    }
  } catch (e) {
    console.warn('[workspaceRestore] restore pass failed:', e);
  } finally {
    WorkspaceState.setTrackingArmed(true);
  }
}

export default { restoreWorkspace };
