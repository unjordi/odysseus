// static/js/term-geometry.js — las decisiones puras del widget de Terminal, fuera del DOM para poder
// probarlas offline (`node scratch/pty-frontend/probe-term-ui.mjs`, exit 0 = verde). Sin imports, sin
// `window`, sin WebSocket: aritmética y una máquina de estados chiquita.
//
// Por qué viven aquí y no inline en terminal.js: son las que se rompieron en producción y las únicas
// verificables sin navegador. Tenerlas puras = tener probe.
//   · `computeGrid`             — cuántas cols/rows CABEN en el área visible (rejilla desbordada).
//   · `createPtySizeReconciler` — qué tamaño mandarle al PTY y CUÁNDO (el shell creía tener menos columnas).
//   · `shouldSuppressInputEvent`— qué `input` es un intermedio de composición y NO debe emitir (el acento
//     suelto de `s´í` sale por ahí, no por el camino de teclas).
//   · `shouldIgnoreKeyEvent`    — qué keydown no debe tocar xterm mientras un IME compone un acento.
//     ⚠️ NO CABLEADA: se probó en vivo y empeoraba el síntoma en el navegador real del usuario
//     (Firefox/Mac, camino `key:"Dead"` sin `keyCode 229`). Se conserva —exportada y con probe— para el
//     camino de IME de verdad (Chrome/Wayland+ibus). No re-cablear sin MEDIR antes: receta en
//     `docs/terminal.md` del repo axon. Ver el comentario de la propia función.

/**
 * cols/rows que CABEN en el área realmente visible del contenedor del emulador.
 *
 * Contrato de las medidas (todas en px CSS, tal cual las da el DOM):
 *  - `boxWidth`/`boxHeight`  = `clientWidth`/`clientHeight` del contenedor (`.term-xterm`). Esa caja ya
 *    EXCLUYE bordes y cualquier scrollbar propia, e INCLUYE el padding → por eso el padding se resta aquí.
 *  - `padLeft/Right/Top/Bottom` = padding computado del MISMO contenedor.
 *  - `scrollbarWidth` = ancho REAL que la scrollbar del `.xterm-viewport` le quita al área de texto
 *    (`offsetWidth - clientWidth` del viewport). Con `scrollbar-gutter: stable` es constante, aparezca o
 *    no la barra → la rejilla no oscila entre "con barra" y "sin barra".
 *  - `minRightGap` (opcional, default 0) = respiro MÍNIMO que debe quedar a la derecha del texto.
 *    El carril de la scrollbar YA es ese respiro donde existe, así que se toma el MAYOR de los dos, no
 *    la suma: sumarlos es justo el bug que costaba una columna (el contenedor traía además su propio
 *    `padding-right`, y padding + carril ≈ 16 px ≈ 2 celdas de margen muerto contra 8 px a la izquierda).
 *    Existe para las plataformas de scrollbars OVERLAY (macOS), donde el carril mide 0 y sin esto el
 *    texto quedaría pegado al borde.
 *  - `cellWidth`/`cellHeight` = `_renderService.dimensions.css.cell` de xterm (métrica de UNA celda con la
 *    fuente que de verdad está rendeando).
 *  - `paintedCellWidth` (opcional, default 0) = paso REAL con el que el navegador PINTA una columna
 *    (avance del glifo + el `letter-spacing` que el DOM-renderer le pone a `.xterm-rows`), medido del DOM.
 *    Existe porque `cellWidth` es lo que xterm CREE que mide una celda y puede NO ser lo que pinta: si algo
 *    heredado (un `letter-spacing` del contenedor) descuadra la medición interna de xterm, cada columna se
 *    pinta más ancha que `cellWidth` y el error se ACUMULA — a 90 columnas, ~20 px que el `overflow: hidden`
 *    del contenedor recorta. Se divide entre el MAYOR de los dos para que quepan las dos cosas: el texto que
 *    de verdad se pinta Y la caja `cols*cellWidth` que xterm le da a `.xterm-screen`.
 *
 * Devuelve `null` cuando alguna medida todavía no es utilizable (contenedor sin layout, o la fuente aún no
 * medida → celda 0). `null` significa "no resizees todavía", NUNCA "usa un default".
 *
 * El `floor` es lo que garantiza que la rejilla nunca sobresalga: cols*paso <= ancho disponible, donde el
 * `paso` es el MAYOR entre lo que xterm cree que mide una celda y lo que el navegador de verdad pinta.
 */
export function computeGrid(m) {
  if (!m) return null;
  const {
    boxWidth, boxHeight,
    padLeft = 0, padRight = 0, padTop = 0, padBottom = 0,
    cellWidth, cellHeight, scrollbarWidth = 0, minRightGap = 0, paintedCellWidth = 0,
  } = m;
  if (!isFinite(cellWidth) || !isFinite(cellHeight) || cellWidth <= 0 || cellHeight <= 0) return null;
  if (!isFinite(boxWidth) || !isFinite(boxHeight)) return null;
  // El carril de la scrollbar y el respiro mínimo ocupan el MISMO espacio: se reserva el mayor, no ambos.
  const rightGap = Math.max(0, scrollbarWidth, isFinite(minRightGap) ? minRightGap : 0);
  const availWidth = boxWidth - padLeft - padRight - rightGap;
  const availHeight = boxHeight - padTop - padBottom;
  if (availWidth <= 0 || availHeight <= 0) return null;
  // Paso HORIZONTAL real de una columna. `cellWidth` es la creencia de xterm (y el ancho que le da a
  // `.xterm-screen`); `paintedCellWidth` es lo que el navegador pinta. Cuando difieren, dividir entre el
  // menor deja la rejilla más ancha que la caja y el contenedor recorta las últimas columnas: se usa el
  // MAYOR, que hace caber ambas. Si no se midió (0 / no finito) se cae a `cellWidth`, el comportamiento previo.
  const painted = isFinite(paintedCellWidth) && paintedCellWidth > 0 ? paintedCellWidth : 0;
  const colPitch = Math.max(cellWidth, painted);
  return {
    cols: Math.max(2, Math.floor(availWidth / colPitch)),
    rows: Math.max(1, Math.floor(availHeight / cellHeight)),
  };
}

/**
 * ¿Este evento de teclado lo está METIENDO un IME / una dead key, y por tanto xterm NO debe tocarlo?
 *
 * Con teclado latinoamericano en Linux (Wayland+ibus) la tecla muerta `´` llega como un keydown "en
 * proceso" (`keyCode` 229 / `key` "Process" / `isComposing`), y el texto REAL — la `é` ya compuesta —
 * llega después por `compositionend` + `input`. Si xterm procesa ese keydown, su CompositionHelper
 * dispara `_handleAnyTextareaChanges()`, que en un `setTimeout(0)` compara el textarea contra su valor
 * previo y emite lo que encuentre; cuando el IME es asíncrono ese timeout corre ANTES de que llegue
 * `compositionstart`, así que emite el acento suelto (U+00B4) y la composición emite después la vocal →
 * el usuario ve `´é`.
 *
 * Devolviendo `true` aquí (y `false` desde `attachCustomKeyEventHandler`) xterm sale de `_keyDown`/
 * `_keyPress` ANTES de tocar el CompositionHelper y SIN `preventDefault()`, así que el textarea sigue
 * recibiendo la composición y `compositionend` entrega la `é` completa, una sola vez.
 *
 * OJO: `key === 'Dead'` NO se ignora. Ese es el otro camino (XKB compone en el propio Chrome, sin IME) y
 * xterm lo necesita para poner su bandera `_unprocessedDeadKey` y dejar que el `keypress` siguiente
 * entregue la vocal ya acentuada. Ignorarlo rompería los acentos en vez de arreglarlos.
 */
export function shouldIgnoreKeyEvent(ev) {
  if (!ev) return false;
  if (ev.isComposing === true) return true;
  if (ev.keyCode === 229) return true;
  if (ev.key === 'Process') return true;
  return false;
}

/**
 * RECONCILIADOR del tamaño del PTY — "recuerda lo que mandaste y converge", en vez de "notifica cuando pase
 * un evento".
 *
 * EL BUG QUE CIERRA (medido 2026-09-07 en el Firefox/Mac del usuario, con `ps` + `stty` del lado servidor):
 * el shell creía tener MENOS columnas que las que xterm rendeaba (115×24 contra 121×24; 119×41 contra
 * 122×41). El PTY sí había recibido UN resize — pero el de una pasada INTERMEDIA del fit, no el final.
 * Dos fugas se suman, y ninguna la tapa un `onResize`:
 *
 *   1. AVISO QUE SE PIERDE. El PTY NACE con las dims que van en la URL del WS, medidas antes de que la Nerd
 *      Font cargara. Todo `term.resize()` anterior a `ws.onopen` dispara `onResize` con el canal cerrado →
 *      se descarta EN SILENCIO. Y el fit es IDEMPOTENTE: si la rejilla ya está en su valor final no vuelve a
 *      llamar a `resize()`, así que `onResize` no dispara nunca más y el desfase queda PERMANENTE.
 *   2. AVISOS QUE COMPITEN. Del lado servidor, cada resize se aplica con un `execFile("stty", ["-F", pts,
 *      …])` FIRE-AND-FORGET, sin serializar (`src/server/pty-session.ts`). Dos frames mandados con
 *      microsegundos de diferencia = dos procesos `stty` en carrera: puede ganar el PRIMERO, y entonces el
 *      winsize final es el de una pasada intermedia aunque el cliente haya mandado el bueno al último.
 *
 * EL INVARIANTE que impone esto: `tamaño del PTY == tamaño de la rejilla de xterm`. Se sostiene con dos
 * piezas, una por fuga:
 *   · Contra (1): se guarda el último tamaño REALMENTE entregado (las dims de la URL cuentan como
 *     entregadas) y se compara contra la rejilla en CADA oportunidad — cada fit, incluidos los diferidos
 *     (rAF, timers, `fonts.ready`), el `ResizeObserver` y el momento de conectar —, sin depender de que
 *     `term.resize()` haya cambiado algo.
 *   · Contra (2): los envíos se COALESCEN. Una ráfaga de fits (que es lo normal al abrir: síncrono, rAF,
 *     rAF², 0 ms, 150 ms) produce UN frame con el valor más reciente, no tres en carrera. Lo hace el
 *     `schedule` inyectado: agenda UN flush por ráfaga y manda lo último que se quiso.
 *
 * IDEMPOTENTE en estado estable: si lo último enviado ya coincide con la rejilla NO manda nada, ni agenda
 * flush. No hay timer periódico — nada dispara un SIGWINCH de más ni re-dibuja el prompt en reposo.
 *
 * NUNCA TIRA: `send` puede lanzar o devolver `false` (WS a medio cerrar); en ese caso el envío NO se
 * registra, así que el siguiente fit lo reintenta solo. Si `schedule` lanza, se manda en el acto.
 *
 * NO fuerza un reenvío al arrancar el PTY a propósito: el servidor ya cubre la ventana previa al marcador de
 * pts con su `pendingResize` (ranura única, gana el último), así que un frame extra "por si acaso" solo
 * agregaría un `stty` en carrera — justo la fuga (2).
 *
 * @param {{ send: (size:{cols:number,rows:number}) => unknown,
 *           schedule?: (flush:() => void) => void }} io
 *        `send` entrega el frame al PTY; devolver `false` (o lanzar) = "no se entregó" → no se registra.
 *        `schedule` difiere el envío para coalescer la ráfaga (en el widget: `setTimeout(fn, 60)`). Por
 *        omisión manda en el acto, que es el comportamiento sin coalescing.
 * @returns un reconciliador con `born/opened/reconcile/closed/state`.
 */
export function createPtySizeReconciler(io) {
  const send = io && typeof io.send === 'function' ? io.send : null;
  const schedule = io && typeof io.schedule === 'function' ? io.schedule : (flush) => flush();
  let sent = null;          // último {cols,rows} entregado al PTY (o con el que NACIÓ vía la URL del WS)
  let wanted = null;        // último {cols,rows} que la rejilla pidió (puede estar aún sin mandar)
  let isOpen = false;       // ¿hay canal vivo? (entre `opened()` y `closed()`)
  let flushPending = false; // ¿ya hay un envío agendado para esta ráfaga?

  /** Normaliza a enteros usables; `null` = medida inservible, no se manda nada. */
  function normalize(size) {
    if (!size) return null;
    const cols = Math.trunc(Number(size.cols));
    const rows = Math.trunc(Number(size.rows));
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
    if (cols < 1 || rows < 1) return null;
    return { cols, rows };
  }

  const stable = (a, b) => !!a && !!b && a.cols === b.cols && a.rows === b.rows;

  /** Manda `wanted` si sigue haciendo falta. Devuelve lo entregado, o null. */
  function flush() {
    flushPending = false;
    if (!wanted || !isOpen || !send) return null;
    if (stable(sent, wanted)) return null;
    const next = wanted;
    let delivered = false;
    try { delivered = send(next) !== false; } catch { delivered = false; }
    if (!delivered) return null;   // no se registra → el próximo fit reintenta solo
    sent = next;
    return next;
  }

  /** Registra lo que la rejilla quiere y agenda UN envío por ráfaga si difiere de lo ya entregado. */
  function want(size) {
    const next = normalize(size);
    if (!next) return null;
    wanted = next;
    if (!isOpen || stable(sent, wanted)) return null;   // estado estable (o sin canal): nada que hacer
    if (flushPending) return next;                      // la ráfaga ya tiene su envío agendado
    flushPending = true;
    try { schedule(flush); } catch { flushPending = false; return flush(); }
    return next;
  }

  return {
    /**
     * El PTY va a NACER con estas dims (las que se meten en la URL del WS). Cuentan como enviadas —son las
     * que el wrapper le pondrá con `stty`— pero el canal aún no está abierto. Llamar ANTES de `new WebSocket`.
     * Reinicia el estado, así que también es lo que hace correcta la RECONEXIÓN: el PTY nuevo vuelve a nacer
     * con las dims de su URL y el reconciliador vuelve a partir de ahí.
     */
    born(size) { sent = normalize(size); wanted = sent; isOpen = false; flushPending = false; return sent; },
    /** `ws.onopen`: hay canal. Empuja de una lo que la rejilla mida AHORA si difiere de lo que nació. */
    opened(size) { isOpen = true; return want(size); },
    /** Tras CUALQUIER fit (sync, diferido, `ResizeObserver`, `fonts.ready`, `onResize`). Idempotente. */
    reconcile(size) { return want(size); },
    /** `ws.onclose`: sin canal no se manda nada hasta el próximo `born`/`opened`. */
    closed() { isOpen = false; return null; },
    /** Introspección para el probe/consola: NO muta nada. */
    state() {
      return {
        sent: sent ? { ...sent } : null,
        wanted: wanted ? { ...wanted } : null,
        isOpen, flushPending,
      };
    },
  };
}

/**
 * ¿Este evento `input` forma parte de una COMPOSICIÓN activa y por tanto NO debe llegar al handler de xterm?
 *
 * EL BUG QUE CIERRA: el acento suelto INTERMITENTE (`s´í`, `hab´ía`). No sale del `CompositionHelper` —ése
 * protege bien—, sale de `Terminal._inputEvent`, cuya guarda está mal para Gecko (literal del bundle
 * vendored, `lib/xterm.js`):
 *
 *     _inputEvent(e){
 *       if (e.data && "insertText" === e.inputType
 *           && (!e.composed || !this._keyDownSeen)          // ← la guarda que falla
 *           && !this.optionsService.rawOptions.screenReaderMode) {
 *         if (this._keyPressHandled) return !1;
 *         this._unprocessedDeadKey = !1;
 *         const t = e.data;
 *         return this.coreService.triggerDataEvent(t, !0), this.cancel(e), !0;   // ← EMITE al PTY
 *       }
 *       return !1;
 *     }
 *
 * En Firefox el primer `input` de la tecla muerta llega con `data="´"` e `isComposing=true`. Si en ese
 * instante `_keyDownSeen` es `false`, la guarda pasa y se emite el `´` ANTES de que la composición entregue
 * la vocal. Y `_keyDownSeen` lo pone `true` `_keyDown` … pero lo vuelve `false` **`_keyUp`** (ambos, literal
 * en el bundle) — DE AHÍ LA INTERMITENCIA:
 *   · `áéíóú` sueltas y rápidas → el `input` cae entre el keydown de la muerta y su keyup, `_keyDownSeen`
 *     sigue `true`, la guarda NO pasa, no se emite nada y la vocal sale por `compositionend`. Limpio (es lo
 *     que se midió: solo C3A1 C3A9 C3AD C3B3 C3BA).
 *   · con consonante previa (`s´í`) el keyup intermedio ya dejó `_keyDownSeen` en `false` → la guarda pasa
 *     → sale el `´` suelto.
 *
 * LA REGLA: durante una composición activa, el ÚNICO emisor legítimo es `compositionend` →
 * `_finalizeComposition`, que entrega la vocal ya compuesta una sola vez. Cualquier `input` con
 * `isComposing === true` es, por definición, un estado INTERMEDIO de esa composición y no debe emitir.
 *
 * POR QUÉ NO SE AFINA MÁS (a `inputType === 'insertText'`, como hace la guarda de xterm): sería atarse a un
 * detalle que varía entre motores —Gecko usa `insertCompositionText` en parte de la secuencia— y el fix se
 * volvería un no-op en cuanto el navegador cambiara de inputType. `isComposing` es la señal SEMÁNTICA
 * ("esto es un intermedio de composición") y suprimirla no puede perder texto: la composición tiene su
 * propio emisor. Fuera de composición (`isComposing` falso o ausente) NO se toca NADA — tecleo normal,
 * pegar, autocompletar y acentos escritos como carácter único siguen su camino intacto.
 *
 * NO se hace `preventDefault()`: el `input` no es cancelable y, sobre todo, el textarea DEBE seguir
 * recibiendo la composición para que `compositionend` entregue la vocal completa. Solo se corta la
 * PROPAGACIÓN hacia el listener de xterm.
 *
 * @param {{ isComposing?: boolean } | null | undefined} ev evento `input`/`beforeinput`.
 * @returns {boolean} true = no dejar que llegue a xterm.
 */
export function shouldSuppressInputEvent(ev) {
  if (!ev) return false;
  return ev.isComposing === true;
}
