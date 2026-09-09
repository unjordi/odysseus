/**
 * tileSlots.js — Cálculo de geometría para un gestor de mosaicos estilo Rectangle.
 *
 * Este módulo es PURO: recibe el rectángulo del área útil y el estado actual,
 * y devuelve el rectángulo destino y el estado nuevo. No toca el DOM, no lee window,
 * no escucha teclas. Se separa así porque un mosaico se prueba con números
 * (¿las dos mitades suman exactamente el ancho?) y eso no se puede probar a través del DOM.
 *
 * El cableado del teclado, la lectura del DOM y la aplicación de los rects viven en tileManager.js.
 */

/**
 * Lista de slots válidos: mitades, cuartos, y operaciones especiales.
 */
export const SLOTS = [
  'left', 'right', 'top', 'bottom',
  'top-left', 'top-right', 'bottom-left', 'bottom-right',
  'maximize', 'center', 'restore',
];

/**
 * Fracciones por las que ciclan las mitades (left, right, top, bottom).
 * Primera vez: 1/2, segunda: 2/3, tercera: 1/3, vuelve a 1/2.
 */
export const FRACCIONES = [1 / 2, 2 / 3, 1 / 3];

/**
 * Estado inicial: ningún slot activo, paso 0, sin geometría guardada.
 */
export function estadoInicial() {
  return { slot: null, paso: 0, libre: null };
}

/**
 * Valida que el área sea usable: los CUATRO campos finitos, y width/height > 0.
 *
 * La finitud se exige en los cuatro y no solo en left/top porque `Infinity > 0`
 * es `true`: un área con `width: Infinity` —que sale de una medición del DOM
 * durante un `resize` o con la pestaña oculta— pasaría un `width > 0` a secas y
 * produciría una ventana de ancho infinito. El `> 0` cuida el caso degenerado de
 * la ventana invisible; `Number.isFinite` cuida el opuesto, y hacen falta los
 * dos. (Lo cazó `tests/tile_slots.test.mjs`: el contrato pedía finitud solo para
 * left/top y el código la implementó tal cual, que es lo correcto de su parte.)
 */
function esAreaValida(area) {
  // El objeto mismo se verifica antes de leerle un campo: `area` llega de una
  // medición del DOM y puede ser `null`/`undefined` (el elemento no está montado
  // todavía). Leer `.left` de un null LANZA, y este módulo promete no lanzar —
  // una promesa que se rompe justo en el caso que el caller no previó.
  if (area === null || typeof area !== 'object') return false;
  return (
    Number.isFinite(area.left) &&
    Number.isFinite(area.top) &&
    Number.isFinite(area.width) &&
    Number.isFinite(area.height) &&
    area.width > 0 &&
    area.height > 0
  );
}

/**
 * Valida que el slot esté en la lista de SLOTS.
 */
export function esSlot(valor) {
  return SLOTS.includes(valor);
}

/**
 * Calcula el rectángulo destino y el estado nuevo.
 *
 * @param {Object} estado - Estado actual: { slot, paso, libre }
 * @param {string} slot - Slot solicitado (debe estar en SLOTS)
 * @param {Object} area - Rectángulo del área útil: { left, top, width, height }
 * @param {Object} rectActual - Rectángulo actual de la ventana: { left, top, width, height }
 * @returns {Object} { rect, estado } donde rect es el destino (o null) y estado es el nuevo
 */
export function calcular(estado, slot, area, rectActual) {
  // Validación: si el área no es usable o el slot no existe, no hacer nada.
  if (!esAreaValida(area) || !esSlot(slot)) {
    return { rect: null, estado };
  }

  // Determinar si es un ciclado: mismo slot que antes.
  const esCiclado = estado.slot === slot && slot !== 'restore';
  const esMitad = ['left', 'right', 'top', 'bottom'].includes(slot);

  // Calcular el paso nuevo.
  let pasoNuevo = 0;
  if (esCiclado && esMitad) {
    // Ciclar por FRACCIONES: (paso + 1) % 3
    pasoNuevo = (estado.paso + 1) % FRACCIONES.length;
  } else if (!esCiclado) {
    // Slot distinto: reiniciar a paso 0.
    pasoNuevo = 0;
  } else {
    // restore, maximize, center: paso siempre 0.
    pasoNuevo = 0;
  }

  // R-3 (auditoría 6ª): `rectActual` viene de fuera y puede ser `null` — este módulo
  // promete NEVER-THROWS y antes lo rompía en dos sitios: `{ ...null }` daba `{}` (una
  // geometría libre BASURA que `restore` habría devuelto al caller con los campos en
  // `undefined`) y `rectActual.width` en `center` LANZABA un TypeError.
  const rectActualUsable =
    rectActual !== null &&
    typeof rectActual === 'object' &&
    Number.isFinite(rectActual.left) &&
    Number.isFinite(rectActual.top) &&
    Number.isFinite(rectActual.width) &&
    Number.isFinite(rectActual.height) &&
    rectActual.width > 0 &&
    rectActual.height > 0;

  // Guardar la geometría libre si pasamos de libre a enmosaicado.
  let libreNuevo = estado.libre;
  if (estado.slot === null && slot !== 'restore') {
    // Primera vez que se enmosaica: guardar rectActual. Si no es usable se guarda
    // `null` — "no sé de dónde venía" —, que es lo honesto: `restore` entonces no
    // hace nada en vez de mandar la ventana a una geometría inventada.
    libreNuevo = rectActualUsable ? { ...rectActual } : null;
  }

  // R-1 (auditoría 6ª): el área se NORMALIZA a enteros AQUÍ, en la frontera, porque
  // viene de una medición del DOM y `getBoundingClientRect` devuelve FLOTANTES de
  // rutina (1280.5). Antes solo se redondeaba la primera parte de la partición y la
  // segunda salía como el resto (`1280.5 - 640 = 640.5`), así que el módulo prometía
  // enteros y entregaba decimales en el caso NORMAL, no en un borde raro. Se usa
  // `floor` en las medidas para no exceder nunca lo que se midió, y `round` en el
  // origen. A partir de aquí toda la aritmética es entera por construcción.
  area = {
    left: Math.round(area.left),
    top: Math.round(area.top),
    width: Math.floor(area.width),
    height: Math.floor(area.height),
  };
  // Un área de 0.4 px de ancho existía antes del floor y ya no: revalidar.
  if (area.width <= 0 || area.height <= 0) {
    return { rect: null, estado: { ...estado } };
  }

  // Calcular el rectángulo destino según el slot.
  let rect = null;

  if (slot === 'restore') {
    // R-6 (auditoría 6ª): si no hay nada que restaurar, el estado se devuelve INTACTO.
    // Antes se limpiaba igual, así que un `restore` que no movió nada le borraba al
    // caller el slot y el paso del ciclo: el siguiente atajo arrancaba desde ½ sin que
    // nada hubiera pasado en pantalla. (El probe no lo cazaba porque solo lo probaba
    // desde el estado inicial, donde limpiar es un no-op — un test que pasa por
    // coincidencia.)
    if (estado.libre === null) {
      return { rect: null, estado: { ...estado } };
    }
    rect = estado.libre;
    // Restaurado: la ventana vuelve a estar libre.
    return {
      rect,
      estado: { slot: null, paso: 0, libre: null },
    };
  }

  if (slot === 'maximize') {
    // Llenar el área completa.
    rect = { ...area };
  } else if (slot === 'center') {
    // Centrar con el tamaño actual, o 60% del área si no es usable.
    let w = rectActualUsable ? rectActual.width : NaN;
    let h = rectActualUsable ? rectActual.height : NaN;

    // Si el tamaño actual no es usable, usar 60% del área.
    if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
      w = Math.round(area.width * 0.6);
      h = Math.round(area.height * 0.6);
    }

    // Recortar al área si excede.
    w = Math.min(w, area.width);
    h = Math.min(h, area.height);

    // Centrar.
    const left = area.left + Math.round((area.width - w) / 2);
    const top = area.top + Math.round((area.height - h) / 2);

    rect = { left, top, width: w, height: h };
  } else if (slot === 'left' || slot === 'right') {
    // Mitad horizontal.
    const fraccion = FRACCIONES[pasoNuevo];
    const w1 = Math.round(area.width * fraccion);
    const w2 = area.width - w1;

    if (slot === 'left') {
      rect = {
        left: area.left,
        top: area.top,
        width: w1,
        height: area.height,
      };
    } else {
      // right — R-2 (auditoría 6ª): la fracción es el tamaño de LA VENTANA que se
      // pidió, no el punto de corte. Antes `right` recibía `w2`, o sea el
      // COMPLEMENTO: el ciclo daba ½ → ⅓ → ⅔ mientras `left` daba ½ → ⅔ → ⅓, así
      // que apretar dos veces "derecha" ENCOGÍA la ventana y dos veces "izquierda"
      // la agrandaba. Es lo primero que un usuario de Rectangle nota.
      // El corte se calcula con la fracción COMPLEMENTARIA y la ventana se lleva el
      // resto: así se conserva la otra invariante —que `left(f)` y `right(1-f)`
      // embaldosan el área EXACTAMENTE, sin el píxel de hueco ni el de traslape.
      const corte = Math.round(area.width * (1 - fraccion));
      rect = {
        left: area.left + corte,
        top: area.top,
        width: area.width - corte,
        height: area.height,
      };
    }
  } else if (slot === 'top' || slot === 'bottom') {
    // Mitad vertical.
    const fraccion = FRACCIONES[pasoNuevo];
    const h1 = Math.round(area.height * fraccion);
    const h2 = area.height - h1;

    if (slot === 'top') {
      rect = {
        left: area.left,
        top: area.top,
        width: area.width,
        height: h1,
      };
    } else {
      // bottom — R-2 (auditoría 6ª), el mismo defecto que `right` en el otro eje:
      // la fracción es el alto de LA VENTANA pedida, no el punto de corte.
      const corte = Math.round(area.height * (1 - fraccion));
      rect = {
        left: area.left,
        top: area.top + corte,
        width: area.width,
        height: area.height - corte,
      };
    }
  } else if (slot === 'top-left' || slot === 'top-right' || slot === 'bottom-left' || slot === 'bottom-right') {
    // Cuartos: mitad de cada eje, siempre a 1/2 (no ciclan).
    const w1 = Math.round(area.width / 2);
    const w2 = area.width - w1;
    const h1 = Math.round(area.height / 2);
    const h2 = area.height - h1;

    if (slot === 'top-left') {
      rect = {
        left: area.left,
        top: area.top,
        width: w1,
        height: h1,
      };
    } else if (slot === 'top-right') {
      rect = {
        left: area.left + w1,
        top: area.top,
        width: w2,
        height: h1,
      };
    } else if (slot === 'bottom-left') {
      rect = {
        left: area.left,
        top: area.top + h1,
        width: w1,
        height: h2,
      };
    } else {
      // bottom-right
      rect = {
        left: area.left + w1,
        top: area.top + h1,
        width: w2,
        height: h2,
      };
    }
  }

  // Estado nuevo.
  const estadoNuevo = {
    slot,
    paso: pasoNuevo,
    libre: libreNuevo,
  };

  return { rect, estado: estadoNuevo };
}
