// static/js/term-instances.js — la CONTABILIDAD de tener N terminales a la vez, fuera del DOM para poder
// probarla offline (`node scratch/pty-frontend/probe-term-instancias.mjs`, exit 0 = verde). Sin `document`,
// sin WebSocket: ids, un registro con orden de uso, una bolsa de disposers y la cascada de la ventana nueva.
//
// Mismo criterio que `./term-geometry.js`: lo que se puede romper en silencio vive PURO para que tenga probe.
// Lo que NO vive aquí es todo lo que toca el DOM/el PTY — eso se queda en `terminal.js`, que consume esto.
//
// POR QUÉ EXISTE (roadmap #29(a)): `terminal.js` era un SINGLETON DE ARCHIVO — un `_ws`, un `_term`, un
// `#term-modal`, y un reconciliador de tamaño en una variable de módulo. El servidor nunca fue el cuello (el
// PTY es por CONEXIÓN), así que abrir dos terminales solo exigía dejar de guardar el estado en el módulo… y
// un **id de instancia explícito** con el que identificar a cada una. Ese id es esta pieza.
//
// EL ID ES TAMBIÉN EL ID DEL DOM. `term-modal` para la primera (el nodo que ya vive en `index.html`, con toda
// su historia de CSS y de cableado en `app.js`) y `term-modal--2`, `--3`… para las siguientes, que son CLONES
// de ese nodo. Que el id de instancia y el id del elemento sean el MISMO string es a propósito: el shell
// entero direcciona ventanas por id de elemento (`modalManager`, `workspaceState`, el `winsize-<id>` de
// `windowResize`), así que una instancia nueva hereda todos esos mecanismos sin traducir nada.

/** La primera instancia REUSA el nodo estático de index.html; por eso su id es el de siempre. */
export const PRIMARY_ID = 'term-modal';

/** Separador del sufijo. Doble guion para no chocar con un id que ya use `-`. */
const SEP = '--';

/**
 * Sufijo de instancia (`''` para la primaria, `--2`, `--3`…). Es lo que se le pega a CADA id de dentro del
 * clon (`term-xterm` → `term-xterm--2`) para que el documento no tenga ids repetidos: dos elementos con el
 * mismo id no rompen el CSS de clase, pero sí `getElementById`, `aria-labelledby` y cualquier cableado viejo
 * que siga buscando por id — y ahí el ganador es el PRIMERO del documento, siempre.
 */
export function instanceSuffix(id) {
  if (!id || id === PRIMARY_ID) return '';
  const i = String(id).indexOf(SEP);
  return i < 0 ? '' : String(id).slice(i);
}

/** Id de instancia para el n-ésimo hueco (1 = la primaria). */
export function instanceIdFor(n) {
  const k = Math.trunc(Number(n));
  return (!Number.isFinite(k) || k <= 1) ? PRIMARY_ID : `${PRIMARY_ID}${SEP}${k}`;
}

/** El id que le toca a un elemento del clon: `term-xterm` + el sufijo de la instancia. */
export function scopedId(baseId, instanceId) {
  const suffix = instanceSuffix(instanceId);
  return suffix ? `${baseId}${suffix}` : baseId;
}

/**
 * Id de sesión del modo ONE-SHOT (degradado) para una instancia.
 *
 * Importa que sea distinto por instancia: del lado de axon el one-shot SÍ está keyed por sesión
 * (`src/server/term-session.ts`), así que dos terminales compartiendo el id compartirían el shell — el cwd de
 * una se le movería a la otra. La primaria conserva el id de siempre (compatibilidad: es el que ya está en
 * `sessionStorage` de las pestañas abiertas), y las demás lo derivan.
 */
export function sessionIdFor(baseSession, instanceId) {
  const suffix = instanceSuffix(instanceId);
  return suffix ? `${baseSession}${suffix}` : baseSession;
}

/**
 * BOLSA DE DISPOSERS — el antídoto al listener huérfano.
 *
 * Cada instancia acumula aquí lo que hay que soltar al morir (el `ResizeObserver` de SU contenedor, el
 * listener de captura del guard de composición, los handlers de sus botones). Garantías:
 *   · cada disposer corre EXACTAMENTE UNA vez, aunque se llame `disposeAll()` dos veces;
 *   · en orden INVERSO al registro (se suelta primero lo último que se enganchó);
 *   · uno que TIRA no impide que corran los demás — si el primero pudiera abortar el barrido, un error
 *     tonto en un `removeEventListener` dejaría vivo el `ResizeObserver`, que es justo lo que se quiere evitar;
 *   · registrar DESPUÉS de disponer ejecuta el disposer en el acto (llegó tarde: nada queda colgando).
 */
export function createDisposerBag() {
  let fns = [];
  let disposed = false;
  const run = (fn) => { try { fn(); } catch (e) { try { console.warn('[term] disposer falló:', e); } catch { /* */ } } };
  return {
    add(fn) {
      if (typeof fn !== 'function') return false;
      if (disposed) { run(fn); return false; }
      fns.push(fn);
      return true;
    },
    size() { return fns.length; },
    isDisposed() { return disposed; },
    disposeAll() {
      if (disposed) return 0;
      disposed = true;
      const pend = fns;
      fns = [];
      for (let i = pend.length - 1; i >= 0; i--) run(pend[i]);
      return pend.length;
    },
  };
}

/**
 * REGISTRO de instancias vivas, con ORDEN DE USO (la última tocada al final).
 *
 * El orden es lo que hace que "abrir la terminal" desde el rail devuelva LA QUE ESTABAS USANDO y no una al
 * azar, y que cerrar una no cambie a cuál vuelves.
 */
export function createInstanceRegistry() {
  const map = new Map();
  const order = [];              // ids, el MÁS RECIENTE al final

  const drop = (id) => {
    const i = order.indexOf(id);
    if (i >= 0) order.splice(i, 1);
  };

  return {
    /**
     * El primer id LIBRE: la primaria si nadie la ocupa (su nodo del HTML se reusa al reabrir), si no el
     * hueco más chico. Rellenar huecos —y no un contador que solo sube— mantiene los ids cortos y estables
     * en una sesión larga de abrir/cerrar, y evita que `winsize-term-modal--47` acumule basura en localStorage.
     */
    nextFreeId() {
      if (!map.has(PRIMARY_ID)) return PRIMARY_ID;
      for (let n = 2; ; n++) {
        const id = instanceIdFor(n);
        if (!map.has(id)) return id;
      }
    },
    add(id, rec) {
      map.set(id, rec);
      drop(id);
      order.push(id);
      return rec;
    },
    get(id) { return map.get(id) || null; },
    has(id) { return map.has(id); },
    size() { return map.size; },
    /** Ids en orden de creación/registro (el más recientemente TOCADO al final). */
    ids() { return order.slice(); },
    all() { return order.map((id) => map.get(id)).filter(Boolean); },
    /** Marca esta instancia como la más reciente (al enfocarla / abrirla). */
    touch(id) {
      if (!map.has(id)) return false;
      drop(id);
      order.push(id);
      return true;
    },
    remove(id) {
      const rec = map.get(id) || null;
      map.delete(id);
      drop(id);
      return rec;
    },
    /** La más reciente que cumpla el predicado (o la más reciente a secas), o null. */
    mostRecent(pred) {
      for (let i = order.length - 1; i >= 0; i--) {
        const rec = map.get(order[i]);
        if (!rec) continue;
        if (!pred || pred(rec)) return rec;
      }
      return null;
    },
  };
}

/**
 * DÓNDE cae la ventana nueva: en CASCADA respecto de la anterior, nunca encima exacta.
 *
 * Dos terminales perfectamente superpuestas se ven como UNA — el usuario cree que el botón no hizo nada. El
 * escalón es el mismo gesto que hace cualquier escritorio al abrir una segunda ventana del mismo programa.
 *
 * @param {{rect:{left:number,top:number,width:number,height:number},
 *          viewport:{width:number,height:number}, step?:number, margin?:number}} o
 * @returns {{left:number, top:number}} posición en px para `position:fixed` (la misma que fija el drag).
 */
export function cascadePosition(o) {
  const { rect, viewport, step = 28, margin = 8 } = o || {};
  if (!rect || !viewport) return null;
  const w = rect.width, h = rect.height;
  if (![rect.left, rect.top, w, h, viewport.width, viewport.height].every((n) => Number.isFinite(n))) return null;
  // Si ya no cabe el escalón, la cascada REINICIA arriba-izquierda en vez de empujar la ventana fuera de la
  // pantalla: una terminal a la que no le ves el header es una terminal que no puedes mover.
  const maxLeft = Math.max(margin, viewport.width - w - margin);
  const maxTop = Math.max(margin, viewport.height - h - margin);
  let left = rect.left + step;
  let top = rect.top + step;
  if (left > maxLeft || top > maxTop) { left = margin; top = margin; }
  return { left: Math.round(Math.min(Math.max(left, margin), maxLeft)), top: Math.round(Math.min(Math.max(top, margin), maxTop)) };
}

export default {
  PRIMARY_ID, instanceSuffix, instanceIdFor, scopedId, sessionIdFor,
  createDisposerBag, createInstanceRegistry, cascadePosition,
};
