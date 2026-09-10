/**
 * railProjection.js — Proyección PURA del estado del workspace al rail.
 *
 * El rail del shell es hoy ESTÁTICO: en app.js (~línea 3805) un `_railToolMap`
 * fijo `{ 'rail-compare':'tool-compare-btn', ... }` solo cablea clicks, y el
 * rail NO refleja qué herramientas están abiertas/minimizadas. #29(b) quiere
 * que el rail PROYECTE el estado del workspace: cada item del rail debe saber
 * si su módulo está abierto, minimizado, cuántas instancias hay y si está
 * activo (visible ahora mismo).
 *
 * Este módulo es PURO: no toca el DOM, no lee `window`, no suscribe a nada,
 * no usa timers. Solo hace el JOIN entre el mapa de estados que devuelve
 * `workspaceState.all()` y la lista de items del rail, y devuelve una vista
 * por item. El cableado real (resolver railId->moduleId en app.js y pintar el
 * rail con estas vistas) es el slice siguiente, como edgeRegions→hostStats.
 *
 * El SHAPE de un módulo en `workspaceState.all()` (ver workspaceState.js, header
 * "SHAPE (v1)") es:
 *   { module, open, minimized, mode, dock, geom, openedAt, updatedAt }
 * El KEY del mapa es la INSTANCIA (hoy == el id del módulo, porque cada tool es
 * singleton; con #29(a) —varias terminales— serán instanceIds distintos del tipo).
 * NO hay campo de "número de instancias": la multiplicidad se expresa como N claves
 * distintas cuyo `.module` es el mismo tipo. Por eso `projectRail` AGRUPA por
 * `.module` (no por la clave del mapa) y `instanceCount` es cuántas instancias de
 * ese tipo están abiertas.
 */

/**
 * Valida que `moduleStates` sea un objeto plano usable como mapa id->estado.
 *
 * `null` y `undefined` no son objetos (`typeof null === 'object'`), así que se
 * rechazan explícitamente: un mapa ausente se trata como vacío, que es la
 * promesa de este módulo — nunca lanzar por una entrada que el caller no previó.
 */
function esMapaValido(moduleStates) {
  return moduleStates !== null && typeof moduleStates === 'object';
}

/**
 * Valida un railItem: debe ser un objeto con `railId` y `moduleId`, ambos
 * cadenas no vacías. Un item sin esos campos (o no-cadena) se OMITE de la
 * salida, sin lanzar.
 */
function esRailItemValido(item) {
  if (item === null || typeof item !== 'object') return false;
  return (
    typeof item.railId === 'string' && item.railId.length > 0 &&
    typeof item.moduleId === 'string' && item.moduleId.length > 0
  );
}

/**
 * Proyecta el estado del workspace al rail.
 *
 * @param {Object} moduleStates - El mapa que devuelve `workspaceState.all()`:
 *   moduleId -> { open, minimized, mode, dock, ... }. Si no es un objeto se
 *   trata como vacío (todo cerrado).
 * @param {Array} railItems - Array de `{ railId, moduleId }`. La resolución
 *   railId->moduleId la hace el CALLER; este módulo solo hace el JOIN. Si no
 *   es un array se devuelve `[]`.
 * @returns {Array} Una vista por railItem, EN EL MISMO ORDEN de entrada:
 *   `{ railId, moduleId, open, minimized, instanceCount, active }` donde:
 *     - `open`         = el módulo existe en moduleStates y su estado dice abierto.
 *     - `minimized`    = abierto pero minimizado.
 *     - `instanceCount`= nº de instancias si el estado lo expone; si no, 1 cuando
 *                        open y 0 cuando no.
 *     - `active`       = open && !minimized (una ventana visible ahora mismo).
 *   Un railItem cuyo moduleId no está en moduleStates → todo false, instanceCount 0.
 */
export function projectRail(moduleStates, railItems) {
  // railItems no-array → [] (la promesa: nunca lanzar).
  if (!Array.isArray(railItems)) return [];

  // moduleStates no-objeto → mapa vacío (todo cerrado), pero seguimos emitiendo
  // una vista por railItem válido.
  const mapa = esMapaValido(moduleStates) ? moduleStates : {};

  const vistas = [];
  for (const item of railItems) {
    // railItem inválido (sin railId/moduleId, o no-cadena) → se omite, sin lanzar.
    if (!esRailItemValido(item)) continue;

    // workspaceState keyea por INSTANCIA; el campo `.module` es el TIPO (ver el
    // header "SHAPE (v1)" de workspaceState.js: la clave es un instanceId y hoy
    // coincide con el tipo SOLO porque cada tool es singleton). Un moduleId (tipo)
    // puede tener N instancias abiertas a la vez —#29(a): varias terminales— así
    // que agrupamos por `.module`, NO por la clave del mapa: un lookup directo
    // `mapa[moduleId]` mostraría el rail cerrado en cuanto la clave fuera un
    // instanceId distinto del tipo (con 3 terminales abiertas, el rail decía cerrado).
    const abiertas = [];
    for (const rec of Object.values(mapa)) {
      if (rec !== null && typeof rec === 'object' && rec.module === item.moduleId && rec.open === true) {
        abiertas.push(rec);
      }
    }

    // instanceCount = cuántas instancias de ESTE tipo están abiertas.
    const instanceCount = abiertas.length;
    const open = instanceCount > 0;
    // active = alguna instancia abierta y NO minimizada (una ventana visible ahora).
    const active = abiertas.some((rec) => rec.minimized !== true);
    // minimized (estado del rail) = abierto pero ninguna visible (todas minimizadas).
    const minimized = open && !active;

    vistas.push({
      railId: item.railId,
      moduleId: item.moduleId,
      open,
      minimized,
      instanceCount,
      active,
    });
  }

  return vistas;
}
