/**
 * modalSwitcher.js — Núcleo PURO del switcher de modales abiertos (#29f, modo teléfono).
 *
 * En viewport de teléfono los modales van a fullscreen de uno en uno (decisión de
 * unjordi, 2026-09-11), así que hace falta un TASK-SWITCHER para navegar entre los
 * que están abiertos. Este módulo es la LÓGICA pura de ese switcher: dado el estado
 * del workspace, produce la lista ordenada de modales abiertos (con su etiqueta y si
 * es el activo) y las funciones de navegación (siguiente/anterior con wrap).
 *
 * PURO como sus hermanos (tileSlots.js, railProjection.js, escGesture.js): no toca el
 * DOM, no lee `window`, no suscribe, no usa timers, NUNCA lanza. El cableado real —leer
 * `workspaceState.openInstances()`, resolver etiquetas del mapa de modalManager, pintar
 * la barra del switcher y traer al frente el modal elegido— es el slice siguiente y vive
 * en el DOM. La UI móvil se QAea en un teléfono real; esta capa se prueba con node --test.
 *
 * SHAPE de entrada (de workspaceState.openInstances(), ver workspaceState.js):
 *   [{ id, module, open, minimized, mode, dock, geom, openedAt, updatedAt }, …]  (oldest-first)
 * El `id` es la INSTANCIA y `module` el TIPO (hoy coinciden en singletons; con #29a
 * —varias terminales— cada instancia es una entrada propia, y el switcher las lista TODAS:
 * navegar entre 3 terminales abiertas es justo lo que el switcher habilita).
 */

/** ¿`rec` es un registro de instancia usable? (objeto con `id` string no vacío). */
function esInstanciaValida(rec) {
  return rec !== null && typeof rec === 'object'
    && typeof rec.id === 'string' && rec.id.length > 0;
}

/**
 * Construye la vista del switcher a partir de las instancias abiertas.
 *
 * @param {Array}  openList  Instancias abiertas (p. ej. workspaceState.openInstances()).
 *   Si no es un array → []. Se CONSERVA el orden de entrada (z-order / restore order).
 *   Las instancias inválidas se OMITEN, sin lanzar.
 * @param {Object} labels    Mapa moduleId→etiqueta (inyectado por el caller desde el mapa
 *   de modalManager). Si falta una etiqueta, se cae al `module` y, si no, al `id`.
 * @param {string} [activeId] Id de la instancia AL FRENTE ahora mismo (o null/undefined).
 * @returns {Array} `[{ id, moduleId, label, minimized, active }]` en el mismo orden.
 *   `active` = (id === activeId). `minimized` = !!rec.minimized.
 */
export function buildSwitcher(openList, labels, activeId) {
  if (!Array.isArray(openList)) return [];
  const mapa = (labels !== null && typeof labels === 'object') ? labels : {};

  const vista = [];
  for (const rec of openList) {
    if (!esInstanciaValida(rec)) continue;
    const moduleId = typeof rec.module === 'string' && rec.module.length > 0 ? rec.module : rec.id;
    const etiqueta = mapa[moduleId];
    vista.push({
      id: rec.id,
      moduleId,
      label: (typeof etiqueta === 'string' && etiqueta.length > 0) ? etiqueta : moduleId,
      minimized: rec.minimized === true,
      active: activeId != null && rec.id === activeId,
    });
  }
  return vista;
}

// Ventanas que son STATUS BARS persistentes (HUD anclado), no "ventanas que uno switchea
// para trabajar en ellas" → fuera del switcher aunque en el DOM sean `.modal` con edge-dock
// (unjordi, 2026-09-15: "Host Stats no debe estar en lo switchable").
const NO_SWITCHEABLES = new Set(['hoststats-modal']);

/**
 * Filtra y ORDENA los descriptores de ventana (leídos en vivo del DOM por el
 * caller — ver modalManager.openToolWindows) para quedarse EXACTAMENTE con las
 * ventanas-herramienta SWITCHEABLES, en el shape que consume buildSwitcher.
 *
 * Criterio de "ventana switcheable" (#29f) — una ventana que el usuario puede
 * ENFOCAR ahora mismo:
 *   1. es una ventana-herramienta real (no un diálogo de confirmación): el caller
 *      lo marca con `isToolWindow` (en el DOM: `.modal` con `_hasEdgeDock`, que
 *      windowDrag pone en las ventanas arrastrables, o `.research-overlay`);
 *   2. está en el DOM (si el caller no la enumeró, no existe — así los fantasmas
 *      de la PERSISTENCIA, p. ej. un `doc-panel` con `open:true` heredado de otra
 *      sesión, ya no se cuelan: la fuente es el DOM vivo, no workspaceState);
 *   3. está ABIERTA (visible) O MINIMIZADA — la minimizada se lista para poder
 *      restaurarla desde el switcher; solo se OMITE la que está oculta y NO
 *      minimizada (esa está cerrada de verdad).
 *
 * Devuelve `[{ id, module, minimized }]` ordenado por z ASCENDENTE (atrás→frente,
 * el mismo sentido "restore order = z-order" que usa openInstances), con
 * desempate estable por el orden de entrada. NUNCA lanza.
 *
 * @param {Array} descriptors `[{ id, module, isToolWindow, hidden, minimized, display, z }]`
 */
export function selectSwitchableWindows(descriptors) {
  if (!Array.isArray(descriptors)) return [];
  const kept = [];
  for (const d of descriptors) {
    if (d === null || typeof d !== 'object') continue;
    if (typeof d.id !== 'string' || d.id.length === 0) continue;
    if (d.isToolWindow !== true) continue;            // fuera diálogos de confirmación
    if (NO_SWITCHEABLES.has(d.id)) continue;          // status bars persistentes, no ventanas switcheables
    const minimized = d.minimized === true;
    const hidden = d.hidden === true || d.display === 'none';
    if (!minimized && hidden) continue;               // cerrada de verdad → fuera
    kept.push(d);
  }
  // Array.prototype.sort es estable en Node/V8 modernos → el desempate por
  // orden de entrada se conserva para z iguales (terminales con z estático).
  kept.sort((a, b) => (Number(a.z) || 0) - (Number(b.z) || 0));
  return kept.map((d) => ({
    id: d.id,
    module: (typeof d.module === 'string' && d.module.length > 0) ? d.module : d.id,
    minimized: d.minimized === true,
  }));
}

/**
 * Índice del id actual en la lista del switcher, o -1 si no está / lista vacía.
 * (Helper interno, exportado para test.)
 */
export function indiceDe(list, currentId) {
  if (!Array.isArray(list)) return -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === currentId) return i;
  }
  return -1;
}

/**
 * Siguiente instancia en el switcher, con WRAP. Devuelve el id.
 *  - lista vacía → null.
 *  - currentId ausente/no-encontrado → el PRIMERO (empezar a navegar desde el inicio).
 *  - último → vuelve al primero (wrap).
 */
export function nextInSwitcher(list, currentId) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const i = indiceDe(list, currentId);
  if (i < 0) return list[0].id;
  return list[(i + 1) % list.length].id;
}

/**
 * Instancia anterior en el switcher, con WRAP. Devuelve el id.
 *  - lista vacía → null.
 *  - currentId ausente/no-encontrado → el ÚLTIMO (al ir "atrás" desde nada, el más reciente).
 *  - primero → salta al último (wrap).
 */
export function prevInSwitcher(list, currentId) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const i = indiceDe(list, currentId);
  if (i < 0) return list[list.length - 1].id;
  return list[(i - 1 + list.length) % list.length].id;
}

export default { buildSwitcher, selectSwitchableWindows, indiceDe, nextInSwitcher, prevInSwitcher };
