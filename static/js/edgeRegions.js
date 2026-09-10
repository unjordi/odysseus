/**
 * edgeRegions.js — Registro PURO de regiones reservadas por borde.
 *
 * Generaliza el mecanismo que hoy vive en hostStats.js (línea ~310), donde un
 * widget único hace `document.body.style.setProperty('--hoststats-dock-h',
 * content.offsetHeight + 'px')` y esa variable la consume SOLO `.chat-input-bar`.
 * Hoy solo un widget puede reservar espacio en un borde; este módulo permite que
 * N widgets reserven en los 4 bordes y que el total por borde se calcule solo.
 *
 * Este módulo es PURO: no toca el DOM, no lee `window`, no usa timers. El único
 * efecto de salida —escribir la variable CSS— se INYECTA como `setVar(nombre,
 * valor)` por el caller, que es quien aplica al DOM. Igual que tileSlots.js y
 * escGesture.js inyectan su IO, aquí se inyecta el sink de escritura. Así se
 * puede probar con números (¿los dos widgets del borde suman exactamente el
 * total?) sin montar nada.
 *
 * El cableado real (hostStats → createEdgeRegions({ setVar }) y la lectura de
 * `--reserved-<edge>` en style.css) es el slice siguiente, como tileSlots→tileManager.
 */

/**
 * Bordes válidos. El orden importa solo para la estabilidad de la iteración.
 */
export const BORDES = ['top', 'bottom', 'left', 'right'];

/**
 * Valida que el borde esté en la lista.
 */
export function esBorde(valor) {
  return BORDES.includes(valor);
}

/**
 * Valida que el tamaño sea un número finito y no negativo.
 *
 * `Number.isFinite` rechaza `NaN`, `Infinity` y `-Infinity` de un golpe, y el
 * `>= 0` cuida el caso de una medición negativa (un `offsetHeight` nunca lo es,
 * pero el valor llega de fuera y puede serlo). Un tamaño no-finito o negativo
 * no se registra: se ignora sin lanzar, que es la promesa de este módulo.
 */
function esTamanoValido(sizePx) {
  return typeof sizePx === 'number' && Number.isFinite(sizePx) && sizePx >= 0;
}

/**
 * Valida el id del widget: debe ser una cadena no vacía. Un id vacío o no-cadena
 * no se registra: se ignora sin lanzar.
 */
function esIdValido(id) {
  return typeof id === 'string' && id.length > 0;
}

/**
 * Crea un registro de regiones reservadas por borde.
 *
 * @param {Object} deps
 * @param {Function} deps.setVar - Sink de IO INYECTADO: `setVar(nombreCssVar, valorPx)`.
 *   El caller aplica al DOM (p. ej. `document.body.style.setProperty(nombre, valor)`);
 *   este módulo NO escribe al DOM. Si no se inyecta, se usa un no-op para que el
 *   módulo siga siendo usable en tests sin IO.
 * @returns {Object} API: { reserve, release, total }
 */
export function createEdgeRegions({ setVar } = {}) {
  // Estado interno: por borde, un mapa id -> sizePx. Un Map por borde mantiene
  // el orden de inserción (útil para depurar) y hace O(1) el reemplazo por id.
  const reservas = {
    top: new Map(),
    bottom: new Map(),
    left: new Map(),
    right: new Map(),
  };

  // El sink de IO: si no se inyectó, no-op. El módulo nunca lanza por falta de IO.
  const aplicar = typeof setVar === 'function' ? setVar : () => {};

  /**
   * Total actual de un borde: SUMA de las reservas de ese borde.
   *
   * REGLA DE COMPOSICIÓN (decisión provisional nocturna, por revisar): los
   * widgets acoplados al MISMO borde se APILAN (no se solapan), así que el total
   * por borde es la SUMA de las reservas de ese borde. Si en el futuro dos widgets
   * del mismo borde pudieran solaparse, esta regla habría que cambiar a MAX en vez
   * de SUMA — unjordi, revísalo antes de cablear a hostStats.
   */
  function total(edge) {
    if (!esBorde(edge)) return 0;
    let suma = 0;
    for (const size of reservas[edge].values()) {
      suma += size;
    }
    return suma;
  }

  /**
   * Recalcula el total de los 4 bordes y emite cada variable CSS.
   * Se llama tras cada reserve/release válido.
   */
  function emitir() {
    for (const edge of BORDES) {
      aplicar(`--reserved-${edge}`, `${total(edge)}px`);
    }
  }

  /**
   * Registra/actualiza la reserva de un widget en un borde.
   *
   * Idempotencia: reservar dos veces el MISMO (edge, id) REEMPLAZA el tamaño
   * anterior, no acumula. Un (edge, id) distinto en el MISMO borde SÍ suma.
   *
   * @param {string} edge - 'top'|'bottom'|'left'|'right'
   * @param {string} id - identificador del widget
   * @param {number} sizePx - tamaño reservado en px
   * @returns {boolean} true si se registró, false si se ignoró por entrada inválida
   */
  function reserve(edge, id, sizePx) {
    if (!esBorde(edge) || !esIdValido(id) || !esTamanoValido(sizePx)) {
      return false;
    }
    // set() reemplaza si el id ya existe: idempotencia por construcción.
    reservas[edge].set(id, sizePx);
    emitir();
    return true;
  }

  /**
   * Quita la reserva de un widget en un borde.
   *
   * @param {string} edge - 'top'|'bottom'|'left'|'right'
   * @param {string} id - identificador del widget
   * @returns {boolean} true si se quitó, false si no existía o la entrada era inválida
   */
  function release(edge, id) {
    if (!esBorde(edge) || !esIdValido(id)) {
      return false;
    }
    const existia = reservas[edge].delete(id);
    if (existia) {
      emitir();
    }
    return existia;
  }

  return { reserve, release, total };
}
