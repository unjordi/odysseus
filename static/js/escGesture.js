/**
 * escGesture.js — el árbitro del GESTO de Escape: tap vs. hold.
 *
 * PORQUÉ EXISTE: el pedido de unjordi es textual — "que las interfaces se
 * cierren con ESC sostenido, configurable desde los settings generales, en
 * vez de al instante". La razón concreta: varios submenús guardan con Enter
 * y obligan a un Escape para cerrarse, y con la terminal de Claude Code
 * adentro el Escape instantáneo te tumba la ventana. Este módulo es el único
 * lugar que decide "esto fue un tap" o "esto fue un hold"; los 38 handlers
 * locales del repo se cuelgan de él.
 *
 * DELIBERADAMENTE LIBRE DE DOM (como escMenuStack.js): no escucha eventos por
 * su cuenta, no toca `document`, no usa `setTimeout` ni `Date` directamente.
 * Recibe los eventos ya capturados y su mundo inyectado, para poder probarlo
 * bajo node puro. La capa DOM —escuchar los eventos y decidir QUÉ se cierra—
 * vive fuera (ui.js / escMenuStack.js).
 *
 * NUNCA LANZA: ni al construirse (mundo puede llegar incompleto) ni al
 * disparar callbacks ajenos (que pueden lanzar). Sin clases: una fábrica que
 * cierra sobre su estado privado.
 */

export const MS_HOLD_POR_DEFECTO = 1500;
export const MS_HOLD_MINIMO = 200;

/**
 * Valida el msHold que viene de las settings del usuario (#32, o sea de
 * fuera). Regla 6: si no es un número FINITO (ojo: Infinity no lo es, y un
 * `> 0` a secas lo dejaría pasar) o si es menor que MS_HOLD_MINIMO, se usa
 * MS_HOLD_POR_DEFECTO. El piso existe porque un hold de 0 o de 20 ms es
 * indistinguible de un tap y devolvería el comportamiento instantáneo
 * fingiendo que la preferencia se respetó, que es peor que ignorarla.
 */
function validarMsHold(msHold) {
  if (typeof msHold !== 'number' || !Number.isFinite(msHold)) {
    return MS_HOLD_POR_DEFECTO;
  }
  if (msHold < MS_HOLD_MINIMO) {
    return MS_HOLD_POR_DEFECTO;
  }
  return msHold;
}

/**
 * Envuelve la llamada a un callback ajeno (alTap/alHold) para que una
 * excepción de ese código no deje al árbitro creyendo que la tecla sigue
 * abajo: si lanzara, el Escape dejaría de funcionar en toda la app hasta
 * recargar. Regla 7.
 */
function llamarSeguro(fn) {
  if (typeof fn === 'function') {
    try {
      fn();
    } catch (e) {
      // Se traga a propósito: el callback es código de otro módulo y su
      // fallo no puede romper el estado interno del árbitro.
    }
  }
}

/**
 * Crea el árbitro del gesto de Escape.
 *
 * mundo = { programar, cancelar, alTap, alHold, msHold }
 *   programar(fn, ms) -> handle   (en producción: setTimeout)
 *   cancelar(handle)  -> void     (en producción: clearTimeout)
 *   alTap()           -> void     (qué hacer con un Escape corto)
 *   alHold()          -> void     (qué hacer con un Escape sostenido)
 *   msHold            -> number   (opcional; cuánto hay que sostener)
 *
 * -> { keydown, keyup, cancelar, estado }
 *   keydown(ev) -> boolean   true si el árbitro TOMÓ el evento
 *   keyup(ev)   -> boolean   true si el árbitro TOMÓ el evento
 *   cancelar()  -> void      olvida el gesto en curso sin disparar nada
 *   estado()    -> { abajo, holdDisparado, msHold }
 */
export function crearArbitroEsc(mundo) {
  // Estado privado. `abajo` = hay un keydown de Escape en curso. `holdDisparado`
  // = el temporizador ya se cumplió y alHold() ya se llamó. `handle` = el
  // handle del temporizador programado (o null si no hay ninguno).
  const msHold = validarMsHold(mundo && mundo.msHold);
  let abajo = false;
  let holdDisparado = false;
  let handle = null;

  // Regla 7: mundo puede llegar null/undefined o sin alguna función. Se
  // resuelve cada función una vez, tolerando que falte (simplemente no se
  // llamará) en vez de lanzar al construirse.
  const programar = mundo && typeof mundo.programar === 'function' ? mundo.programar : null;
  const cancelarHandle = mundo && typeof mundo.cancelar === 'function' ? mundo.cancelar : null;
  const alTap = mundo && mundo.alTap;
  const alHold = mundo && mundo.alHold;

  function keydown(ev) {
    // Regla 7: un ev que no sea un objeto con `key` se trata como "no es mío".
    if (!ev || typeof ev !== 'object' || !('key' in ev)) {
      return false;
    }
    // Regla 4: solo Escape. Se devuelve false (no true) porque el valor de
    // retorno le dice al caller si puede seguir procesando el evento con sus
    // propios atajos: tomar una tecla que no es tuya rompe los demás atajos
    // en silencio.
    if (ev.key !== 'Escape') {
      return false;
    }
    // Regla 1 (la que decide si la función sirve): el auto-repeat del teclado
    // NO reinicia el temporizador. Mientras una tecla se mantiene apretada el
    // navegador emite keydown REPETIDOS (ev.repeat === true); si cada
    // repetición reprogramara el temporizador, el hold jamás se cumpliría —
    // el usuario sostendría Escape para siempre y nada pasaría, sin ningún
    // error visible. Así que un keydown con ev.repeat === true, o cualquier
    // keydown cuando ya hay un gesto en curso, se ignora: se devuelve true
    // (el árbitro lo tomó) pero no se reprograma nada.
    if (ev.repeat === true || abajo) {
      return true;
    }
    // Primer keydown real: arranca el gesto y programa el temporizador.
    abajo = true;
    holdDisparado = false;
    if (programar) {
      handle = programar(function () {
        // El temporizador se cumplió: esto fue un hold. Se marca el gesto
        // ANTES de llamar al callback, para que el keyup posterior no dispare
        // además un tap (regla 2).
        holdDisparado = true;
        handle = null;
        llamarSeguro(alHold);
      }, msHold);
    }
    return true;
  }

  function keyup(ev) {
    // Regla 7: un ev que no sea un objeto con `key` se trata como "no es mío".
    if (!ev || typeof ev !== 'object' || !('key' in ev)) {
      return false;
    }
    // Regla 4: solo Escape.
    if (ev.key !== 'Escape') {
      return false;
    }
    // Regla 3: un keyup sin su keydown no dispara nada. Pasa de verdad: el
    // keydown ocurrió mientras otro elemento tenía el foco, o la ventana lo
    // perdió a mitad del gesto y solo llega el keyup. Un Escape que nadie
    // apretó aquí cerrando una ventana es peor que uno que no cierra nada.
    // Se devuelve false (el árbitro NO lo tomó) para que quien llame sepa
    // que ese evento no era suyo.
    if (!abajo) {
      return false;
    }
    // El gesto termina aquí. Se limpia el estado antes de decidir qué
    // disparar, para que un callback que lance no deje el árbitro creyendo
    // que la tecla sigue abajo (regla 7).
    const fueHold = holdDisparado;
    abajo = false;
    holdDisparado = false;
    if (handle !== null && cancelarHandle) {
      cancelarHandle(handle);
      handle = null;
    }
    // Regla 2: un hold que ya disparó NO dispara además un tap al soltar. Si
    // llamara a los dos, un Escape sostenido cerraría DOS cosas — que es
    // estrictamente peor que el Escape instantáneo que este cambio vino a
    // arreglar. Solo un tap (hold no disparado) llama a alTap.
    if (!fueHold) {
      llamarSeguro(alTap);
    }
    return true;
  }

  function cancelar() {
    // Regla 5: olvida el gesto en curso sin disparar nada. Es lo que el
    // caller llama en blur y en visibilitychange: si la ventana pierde el
    // foco a mitad de un hold, el temporizador se cumpliría más tarde y
    // cerraría algo que el usuario ya no está mirando. Después de cancelar(),
    // un keyup pendiente tampoco dispara un tap (regla 3: ya no hay gesto en
    // curso).
    abajo = false;
    holdDisparado = false;
    if (handle !== null && cancelarHandle) {
      cancelarHandle(handle);
      handle = null;
    }
  }

  function estado() {
    // Regla 8: devuelve una COPIA. Si devolviera el objeto interno, cualquier
    // caller podría mutarlo y dejar al árbitro en un estado que él no
    // produjo. Es la misma razón por la que los módulos de este repo devuelven
    // copias en sus getters (ver workspaceState.js). msHold devuelve el valor
    // que de verdad se está usando, para que la UI muestre el efectivo y no el
    // pedido (regla 6).
    return {
      abajo: abajo,
      holdDisparado: holdDisparado,
      msHold: msHold,
    };
  }

  return {
    keydown: keydown,
    keyup: keyup,
    cancelar: cancelar,
    estado: estado,
  };
}
