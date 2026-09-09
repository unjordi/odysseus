// static/js/terminal.js — widget de Terminal INTERACTIVA (PTY real) del panel de Odysseus.
//
// EVOLUCIÓN: antes era un runner ONE-SHOT (input + Run → <pre> con texto crudo, sin ANSI, sin interactivos:
// los REPL recibían EOF y salían). Ahora es una TERMINAL DE VERDAD: xterm.js (emulador ANSI + teclado) sobre
// un PTY bidireccional servido por axon en `WS /api/axon/term/pty` — corre `claude`/vim/python/top/ssh en TU
// HOST (vía el broker host-side) o en el contenedor, según el modo (badge honesto vía GET /api/axon/term/mode).
//
// TRANSPORTE: WebSocket same-origin (el navegador manda la cookie de sesión de Odysseus sola → el handshake
// de axon la valida; NADA de PTY sin auth). Protocolo (ver term-pty-bridge.ts del repo axon):
//   cliente→servidor: frame BINARY = stdin (keystrokes; Ctrl-C=\x03 viaja como byte) · TEXT = {"type":"resize",cols,rows}
//   servidor→cliente: frame BINARY = salida cruda del PTY (→ term.write) · TEXT = {"type":"exit"|"error",...}
//
// DEGRADACIÓN: si el PTY no está disponible (WS no conecta, o xterm.js no cargó), cae al modo ONE-SHOT
// clásico (input + <pre>, POST /api/axon/term) — que sigue INTACTO en el backend. El badge y el botón Clear
// se conservan en ambos modos.
//
// GEOMETRÍA: las decisiones que se rompieron en producción viven PURAS en `./term-geometry.js`, para poder
// probarlas sin navegador (`node scratch/pty-frontend/probe-term-ui.mjs`, exit 0 = verde): cuántas cols/rows
// caben en el área visible (`computeGrid`) y qué tamaño mandarle al PTY y cuándo (`createPtySizeReconciler`).
//
// ANCHO DE COLUMNA — LO QUE SE PINTA MANDA, NO LO QUE XTERM CREE: `dimensions.css.cell.width` puede NO ser el
// paso con el que el navegador pinta. xterm mide el glifo en un contenedor oculto y cuadra la diferencia con
// un `letter-spacing` inline en `.xterm-rows`; si algo HEREDADO contamina esa medición, cada columna se pinta
// más ancha y el error se acumula hasta que el `overflow: hidden` del contenedor recorta las últimas
// columnas. El CSS corta la herencia (`#term-xterm .xterm { letter-spacing: normal }`) y aquí se MIDE el paso
// real (`_measurePaintedCellWidth`) como red — ver ambos comentarios.
//
// TAMAÑO DEL PTY — RECONCILIAR, NO NOTIFICAR: el shell debe creer EXACTAMENTE el tamaño que xterm rendea.
// Avisarle "cuando pase un evento" no alcanza (el PTY nace con las dims de la URL del WS, los resize
// anteriores a `onopen` se descartan, y el fit es idempotente → si la rejilla ya está bien nada vuelve a
// disparar). Aquí se GUARDA lo último enviado y se compara contra la rejilla en cada fit — ver
// `createPtySizeReconciler`.

import { makeWindowDraggable } from './windowDrag.js';
import { computeGrid, createPtySizeReconciler, shouldSuppressInputEvent } from './term-geometry.js';

let _wired = false;
let _badgeFetched = false;

// PTY (modo interactivo)
let _term = null;         // instancia de xterm.js
let _ws = null;           // WebSocket del PTY
let _ptyConnected = false;
let _ptyReady = false;    // ya intentamos abrir PTY al menos una vez este open()
let _gotOutput = false;   // ¿el PTY emitió algo? (para degradar si muere instantáneo, p. ej. sin `script`)
let _ptyOpenedAt = 0;
let _resizeObs = null;

// Único emisor de `{type:'resize'}` hacia el PTY. Recuerda lo último entregado (incluidas las dims con las
// que el PTY NACIÓ vía la URL del WS) y solo manda cuando difiere de la rejilla → converge sin depender de
// que un evento dispare en el momento correcto, y en reposo no manda NADA (cero SIGWINCH de más).
const _ptySize = createPtySizeReconciler({
  send: ({ cols, rows }) => {
    if (!_ws || !_ptyConnected) return false;                    // sin canal: no se entregó, se reintenta
    try { _ws.send(JSON.stringify({ type: 'resize', cols, rows })); return true; } catch { return false; }
  },
  // Coalesce la RÁFAGA de fits en UN frame. No es cosmético: del otro lado cada resize se aplica con un
  // `execFile("stty", ["-F", pts, …])` fire-and-forget SIN serializar (src/server/pty-session.ts), así que
  // dos frames con microsegundos de diferencia son dos `stty` en carrera y puede ganar el intermedio. 60 ms
  // cubre la ráfaga de apertura (síncrono + rAF + rAF² + 0 ms) sin que se note, y durante un drag del modal
  // actúa como throttle con el valor más fresco (≈16 SIGWINCH/s en vez de 60).
  schedule: (flush) => { setTimeout(flush, 60); },
});
/** Tamaño ACTUAL de la rejilla de xterm (lo que el usuario ve), o null si aún no hay emulador. */
function _gridSize() { return _term ? { cols: _term.cols, rows: _term.rows } : null; }
/** Reconcilia PTY↔rejilla. Never-throws: un send fallido jamás puede tumbar el widget. */
function _reconcilePtySize() { try { _ptySize.reconcile(_gridSize()); } catch { /* */ } }

// `session` id estable por pestaña (mantenido por compatibilidad con el modo one-shot; el PTY es por-conexión).
const _session = (() => {
  const mk = () => 'term-' + ((globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2));
  try {
    let s = sessionStorage.getItem('axon-term-session');
    if (!s) { s = mk(); sessionStorage.setItem('axon-term-session', s); }
    return s;
  } catch { return mk(); }
})();

function _els() {
  return {
    modal: document.getElementById('term-modal'),
    badge: document.getElementById('term-scope-badge'),
    xterm: document.getElementById('term-xterm'),   // contenedor del emulador (modo PTY)
    oneshot: document.getElementById('term-oneshot'), // contenedor del modo degradado (input + <pre>)
    output: document.getElementById('term-output'),
    input: document.getElementById('term-input'),
    runBtn: document.getElementById('term-run-btn'),
    stopBtn: document.getElementById('term-stop-btn'),
    clearBtn: document.getElementById('term-clear-btn'),
  };
}

/**
 * Badge de ALCANCE de la terminal. TRES estados, porque axon ahora SONDEA al broker en vez de deducir el
 * modo de que las env estén puestas (`GET /api/axon/term/mode`):
 *   host       — corre en la máquina del usuario. El broker contestó.
 *   container  — no hay broker configurado; corre dentro del contenedor.
 *   host-down  — hay broker configurado pero NO responde (o rechaza el token) ⇒ la terminal va a fallar,
 *                y NO cae al shell del contenedor (sería otra máquina). Se pinta distinto a `container`
 *                a propósito: "no hay host" y "el host está caído" son problemas distintos.
 *
 * Por qué importa (bug 2026-09-07): el badge decía `host` mientras cada comando moría en 502, porque el
 * endpoint solo miraba `Boolean(URL && TOKEN)`. Un badge calculado de la CONFIGURACIÓN no puede ser honesto
 * sobre el ESTADO. Con `host-down` NO se latchea el resultado: se vuelve a sondear en cada apertura del
 * widget, para que el badge se cure solo en cuanto el broker vuelva.
 */
async function _refreshBadge() {
  if (_badgeFetched) return;
  const { badge } = _els();
  if (!badge) return;
  let mode = 'container', ok = false, detail = '';
  try {
    const res = await fetch('/api/axon/term/mode', { credentials: 'same-origin' });
    if (res.ok) {
      const d = await res.json();
      if (d && (d.mode === 'host' || d.mode === 'container' || d.mode === 'host-down')) {
        ok = true; mode = d.mode; detail = typeof d.detail === 'string' ? d.detail : '';
      }
    }
  } catch { /* deja container */ }
  // `host-down` es transitorio: no se cachea, así el badge se recupera cuando el broker vuelva.
  if (ok && mode !== 'host-down') _badgeFetched = true;
  badge.textContent = mode === 'host-down' ? 'host ⚠' : mode;
  badge.classList.toggle('host', mode === 'host');
  badge.classList.toggle('host-down', mode === 'host-down');
  badge.classList.toggle('container', mode === 'container');
  badge.title = mode === 'host'
    ? 'Corre en tu HOST (vía el broker de axon), como tú — ver docs/terminal.md'
    : mode === 'host-down'
      ? `El broker del host está configurado pero NO responde: los comandos van a fallar (no se cae al shell del contenedor a propósito — sería otra máquina). ${detail}`.trim()
      : 'Corre dentro del contenedor de axon (cwd del maincar), no en tu host — ver docs/terminal.md';
}

// ─────────────────────────────── modo PTY (xterm.js + WebSocket) ───────────────────────────────

/** ¿xterm.js está cargado como global? (lo carga index.html vía /static/lib/xterm.js UMD → globalThis.Terminal). */
function _xtermAvailable() {
  return typeof globalThis.Terminal === 'function';
}

function _wsUrl(cols, rows) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/axon/term/pty?cols=${cols}&rows=${rows}`;
}

/**
 * ACENTOS: corta el `input` de una composición ANTES de que llegue a `Terminal._inputEvent`, que es de donde
 * sale el `´` suelto de `s´í`/`hab´ía` (el porqué exacto, con el código del bundle, está en
 * `shouldSuppressInputEvent`). Aquí solo vive el CÓMO, que no es obvio:
 *
 * xterm registra su listener así (literal de `lib/xterm.js`, y `addDisposableDomListener(e,t,i,s)` no hace
 * más que `e.addEventListener(t,i,s)`):
 *
 *     addDisposableDomListener(this.textarea, "input", (e) => this._inputEvent(e), true)
 *
 * O sea: sobre **el textarea mismo**, en CAPTURA. Y en el nodo TARGET el orden de invocación es el de
 * REGISTRO, tenga o no la bandera de captura → registrar nuestro listener también en el textarea NO sirve:
 * xterm lo registró al construirse (el textarea ni siquiera existe antes) y correría primero, con el `´` ya
 * emitido. Por eso el corte va en un **ANCESTRO**: la fase de captura recorre los ancestros ANTES de la fase
 * de target, así que un listener de captura en el contenedor corre con garantía antes que el de xterm, y
 * `stopImmediatePropagation()` ahí impide que el evento llegue siquiera al textarea.
 *
 * `beforeinput` no se toca: el bundle registra CERO listeners de ese tipo (verificado), así que interceptarlo
 * no cortaría nada y sí podría estorbarle a la composición.
 *
 * Efecto colateral revisado: al no correr `_inputEvent`, no se limpia su `_unprocessedDeadKey`. No es una
 * regresión — es EXACTAMENTE el estado en que ya queda hoy el caso que el usuario midió como LIMPIO (acentos
 * sueltos: ahí la guarda de xterm tampoco deja entrar a `_inputEvent`, y funciona). El fix hace que el caso
 * roto se comporte como el que ya se verificó bueno.
 */
function _wireCompositionGuard(term, container) {
  let ta = null;
  try { ta = term.textarea || (term.element && term.element.querySelector('textarea')) || null; } catch { /* */ }
  // El contenedor es ancestro del textarea en el DOM que arma `term.open()`; si por lo que sea no lo fuera,
  // `document` también es ancestro y sirve igual (el filtro por target lo mantiene acotado).
  let host = document;
  try { if (ta && container && container.contains(ta)) host = container; } catch { /* */ }
  const onInputCapture = (ev) => {
    try {
      if (ta && ev.target !== ta) return;              // acotado al textarea del emulador
      if (!shouldSuppressInputEvent(ev)) return;       // fuera de composición: NO se toca nada
      ev.stopImmediatePropagation();                   // NO preventDefault: el textarea debe seguir componiendo
    } catch { /* jamás tumbar el widget por esto */ }
  };
  try { host.addEventListener('input', onInputCapture, true); } catch { /* sin captura: queda el bug, no un crash */ }
}

/**
 * Crea (una vez) la instancia de xterm y la monta en #term-xterm.
 * PRE-REQUISITO: #term-xterm ya debe estar VISIBLE. `term.open()` sobre un contenedor `display:none` mide la
 * celda como 0×0, y todo ajuste posterior aborta al ver celda 0 → la rejilla se queda en 80×24 (ver `_openPty`).
 */
function _ensureTerm() {
  if (_term) return _term;
  const { xterm } = _els();
  if (!xterm || !_xtermAvailable()) return null;
  const term = new globalThis.Terminal({
    cursorBlink: true,
    // Encabeza con la Nerd Font (glifos/powerline del prompt de unjordi); FiraCode/Menlo/… de fallback.
    fontFamily: '"MesloLGSDZ Nerd Font Mono", "FiraCode", "Fira Code", Menlo, Consolas, monospace',
    fontSize: 13,
    scrollback: 5000,
    theme: { background: '#1e1e2e', foreground: '#cdd6f4' },
  });
  // ACENTOS / dead keys (teclado latinoamericano en Linux/Wayland/Chrome): mientras el IME compone, xterm no
  // debe tocar el keydown — su CompositionHelper emitiría el acento SUELTO antes de que llegue la vocal
  // compuesta. El porqué exacto está en `shouldIgnoreKeyEvent`. Devolver `false` = "xterm, ignora este evento"
  // (sale de _keyDown/_keyPress sin preventDefault → el textarea sigue recibiendo la composición).
  // ⛔ REVERTIDO 2026-09-07 (regresión medida en vivo): esta compuerta cambiaba el síntoma de MALO a PEOR —
  // antes el acento se DUPLICABA (`tambi´én`), con ella el carácter acentuado se PERDÍA por completo
  // (`est s`, `estimaci n`). Perder la letra es peor que duplicarla. La hipótesis "Chrome marca la tecla
  // muerta como IME (keyCode 229)" no se sostuvo: bloquear ese keydown también mata la entrega de la vocal
  // compuesta. El fix del VIEWPORT (medición propia, re-fit, gutter estable) NO depende de esto y se queda.
  // MEDIDO DESPUÉS en el navegador real del usuario (Firefox/Mac, no Chrome/Wayland): `keydown key:"Dead"
  // keyCode:219` + composición limpia, SIN `keyCode 229`, y al PTY llegan los bytes UTF-8 exactos — ese
  // camino ya funciona sin compuerta. `shouldIgnoreKeyEvent` sigue en `./term-geometry.js` (exportada, con
  // probe) para el camino de IME de verdad (Chrome/Wayland+ibus); re-cablearla es re-agregarla al import de
  // arriba y descomentar la línea de abajo — pero primero MIDE, receta en `docs/terminal.md` del repo axon.
  // try { term.attachCustomKeyEventHandler((ev) => !shouldIgnoreKeyEvent(ev)); } catch { /* build sin la API */ }
  term.open(xterm);
  // El acento suelto se corta AQUÍ, en el camino de `input` (no en el de teclas) — ver _wireCompositionGuard.
  // Va después de `term.open()` porque el textarea helper no existe hasta entonces.
  _wireCompositionGuard(term, xterm);
  // Alt-screen (vim/top/claude TUI): sin scrollback → marca el contenedor para ocultar la scrollbar.
  try {
    if (term.buffer && typeof term.buffer.onBufferChange === 'function') {
      term.buffer.onBufferChange(() => {
        const alt = term.buffer.active && term.buffer.active.type === 'alternate';
        xterm.classList.toggle('term-alt-screen', !!alt);
      });
    }
  } catch { /* API de buffer no disponible: el CSS overflow:auto ya cubre el caso normal */ }
  // Re-fit cuando la Nerd Font YA cargó: la 1ª medición pudo usar la métrica del fallback (cols/rows erróneos).
  try {
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { if (_term === term) _scheduleFit(); }).catch(() => {});
    }
  } catch { /* sin FontFaceSet: la fuente cargará y el próximo resize re-fitea */ }
  // teclado del usuario → stdin del PTY (bytes crudos; xterm ya traduce Enter/Ctrl-C/flechas a las secuencias).
  term.onData((data) => {
    if (_ws && _ptyConnected) { try { _ws.send(new TextEncoder().encode(data)); } catch { /* ws cerrado */ } }
  });
  // resize del emulador → reconcilia (NO manda directo: el reconciliador es el único emisor, para que
  // "lo último enviado" nunca mienta). Es una de varias entradas, no la única: `onResize` solo dispara si
  // `term.resize()` CAMBIÓ algo, y el desfase que sufríamos vivía justo donde no cambiaba nada.
  term.onResize(() => _reconcilePtySize());
  _term = term;
  return term;
}

/** Cuántas 'W' mide el probe de paso real: suficientes para que el redondeo del rect no pese, y baratas. */
const _PITCH_PROBE_LEN = 64;

/**
 * Paso HORIZONTAL con el que el navegador PINTA una columna: avance del glifo + el `letter-spacing` que el
 * DOM-renderer de xterm le pone INLINE a `.xterm-rows`. En px CSS; 0 si aún no es medible.
 *
 * POR QUÉ NO BASTA `dimensions.css.cell.width`: ese es lo que xterm CREE que mide una celda. xterm lo deriva
 * de su propia medición del glifo y luego "cuadra" la diferencia poniéndole `letter-spacing` a las filas
 * (`_setDefaultSpacing`: `cellWidth − widthCache('W')`). Si su medición estaba sesgada — p. ej. porque un
 * `letter-spacing` HEREDADO contaminó el contenedor oculto con el que mide —, ese ajuste inline SUSTITUYE al
 * heredado en vez de sumarse y cada columna se pinta más ancha que `cellWidth`. El error es por columna, así
 * que se ACUMULA: medido el 2026-09-08 en Chrome, 8 px declarados contra 8.21875 px pintados = ~20 px a 90
 * columnas, justo las ~2 celdas que el `overflow: hidden` del contenedor recortaba. El CSS ya neutraliza esa
 * herencia (`#term-xterm .xterm { letter-spacing: normal }`); esta medición es la RED: mide lo que de verdad
 * se pinta, venga el desajuste de donde venga (una fuente que carga tarde, otro estilo heredado mañana).
 *
 * El probe se cuelga del PADRE de `.xterm-rows` (`.xterm-screen`), NUNCA de `.xterm-rows`: sus hijos los
 * indexa el renderer por posición y meterle uno propio le rompería el mapeo de filas. Copia las propiedades
 * de texto computadas de las filas —no hereda—, así mide exactamente el mismo paso que ellas.
 */
function _measurePaintedCellWidth() {
  try {
    const rowsEl = _term && _term.element ? _term.element.querySelector('.xterm-rows') : null;
    if (!rowsEl || !rowsEl.parentNode) return 0;
    const cs = getComputedStyle(rowsEl);
    const probe = document.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;top:0;left:-9999em;visibility:hidden;pointer-events:none;white-space:pre;line-height:normal';
    probe.style.fontFamily = cs.fontFamily;
    probe.style.fontSize = cs.fontSize;
    probe.style.fontWeight = cs.fontWeight;
    probe.style.fontStyle = cs.fontStyle;
    probe.style.fontKerning = cs.fontKerning;
    probe.style.letterSpacing = cs.letterSpacing;
    probe.style.wordSpacing = cs.wordSpacing;
    probe.textContent = 'W'.repeat(_PITCH_PROBE_LEN);
    rowsEl.parentNode.appendChild(probe);
    let width = 0;
    try { width = probe.getBoundingClientRect().width / _PITCH_PROBE_LEN; } finally { probe.remove(); }
    return isFinite(width) && width > 0 ? width : 0;
  } catch { return 0; }
}

/**
 * Vuelve a alinear la métrica INTERNA de xterm con lo que se pinta, cuando se detecta que divergieron.
 *
 * Que la rejilla no se recorte lo resuelve solo `computeGrid` (divide entre el paso mayor), pero eso deja a
 * xterm creyendo un ancho de celda que no es el pintado, y con ESA creencia posiciona lo que dibuja por
 * coordenadas de celda —el rectángulo de selección y el mapeo de un clic a columna—, que quedarían corridos
 * a la derecha. `handleCharSizeChanged()` del render service es lo que limpia el `WidthCache` del
 * DOM-renderer y recalcula el `letter-spacing` de las filas, así que la divergencia se CIERRA en vez de solo
 * compensarse. Es API interna del bundle: todo va en try/catch y si no existe, la red de `computeGrid` sigue
 * sosteniendo el caso.
 */
function _resyncCharMetrics() {
  try {
    const core = _term && _term._core;
    if (!core) return false;
    if (core._charSizeService && typeof core._charSizeService.measure === 'function') core._charSizeService.measure();
    if (core._renderService && typeof core._renderService.handleCharSizeChanged === 'function') {
      core._renderService.handleCharSizeChanged();
      return true;
    }
  } catch { /* bundle sin esa API: queda la red de computeGrid */ }
  return false;
}

/**
 * Mide el área REALMENTE visible del contenedor + la métrica de celda vigente. Devuelve null si algo aún no
 * es medible (contenedor sin layout, o fuente sin medir) — en ese caso NO se resizea.
 *
 * NO usamos `FitAddon.fit()`: su `proposeDimensions()` resta `Viewport.scrollBarWidth`, que xterm calcula UNA
 * sola vez en el constructor del Viewport como `viewport.offsetWidth - scrollArea.offsetWidth || 15`. Como el
 * emulador se abría con el contenedor oculto, esa resta daba 0-0 y caía al literal **15**, que no corresponde
 * a la barra real (8px en nuestro CSS, 0 cuando no hay overflow) y jamás se recalcula. Aquí medimos la barra
 * viva y el padding real del contenedor en CADA pasada.
 */
function _measureGrid() {
  const { xterm } = _els();
  if (!xterm || !_term) return null;
  const core = _term._core;
  if (!core) return null;
  // Si la celda nunca se pudo medir (contenedor oculto al abrir), fuérzalo ahora que sí hay layout.
  try {
    if (core._charSizeService && !core._charSizeService.hasValidSize) core._charSizeService.measure();
  } catch { /* sin medición: computeGrid devolverá null y no resizeamos */ }
  const cell = core._renderService && core._renderService.dimensions && core._renderService.dimensions.css
    ? core._renderService.dimensions.css.cell
    : null;
  if (!cell) return null;
  const cs = getComputedStyle(xterm);
  const viewportEl = _term.element ? _term.element.querySelector('.xterm-viewport') : null;
  // Ancho que la scrollbar le quita al texto. Con `scrollbar-gutter: stable` (ver `#term-xterm` en
  // static/style.css) es CONSTANTE haya o no overflow → la rejilla no oscila al aparecer/desaparecer la barra.
  const scrollbarWidth = viewportEl ? Math.max(0, viewportEl.offsetWidth - viewportEl.clientWidth) : 0;
  const padLeft = parseFloat(cs.paddingLeft) || 0;
  return {
    // clientWidth/Height = caja de padding, SIN bordes ni scrollbar propia: lo que de verdad se ve.
    boxWidth: xterm.clientWidth,
    boxHeight: xterm.clientHeight,
    padLeft,
    padRight: parseFloat(cs.paddingRight) || 0,
    padTop: parseFloat(cs.paddingTop) || 0,
    padBottom: parseFloat(cs.paddingBottom) || 0,
    cellWidth: cell.width,
    cellHeight: cell.height,
    // Lo que xterm CREE que mide una celda (`cell.width`) vs lo que el navegador PINTA. Cuando difieren, el
    // segundo es el que decide si la última columna cabe — ver `_measurePaintedCellWidth`.
    paintedCellWidth: _measurePaintedCellWidth(),
    scrollbarWidth,
    // El margen derecho lo hace el CARRIL de la scrollbar (el CSS deja `padding-right: 0` justo para que
    // carril y padding no se sumen y se coman una columna). Donde la plataforma usa scrollbars OVERLAY el
    // carril mide 0, así que se pide un respiro mínimo igual al padding IZQUIERDO: el texto queda
    // simétrico en ambos casos, y en ninguno se reserva el espacio dos veces.
    minRightGap: padLeft,
  };
}

/**
 * Ajusta la rejilla al contenedor. Itera hasta 3 veces porque `term.resize()` dispara `_afterResize` →
 * `charSizeService.measure()`: la 1ª pasada puede haber usado una métrica de celda vieja (la del fallback,
 * antes de que cargara la Nerd Font) y la 2ª ya la corrige. Para en cuanto la medida se estabiliza.
 */
function _fitNow() {
  if (!_term) return;
  let resynced = false;
  for (let i = 0; i < 3; i++) {
    let m = _measureGrid();
    // Si lo pintado y lo declarado no coinciden, primero se intenta CERRAR la divergencia (una sola vez por
    // pasada, para no rebotar) y se vuelve a medir; lo que quede lo absorbe `computeGrid` con el paso mayor.
    if (m && !resynced && m.paintedCellWidth > 0 && Math.abs(m.paintedCellWidth - m.cellWidth) > 0.01) {
      resynced = true;
      if (_resyncCharMetrics()) m = _measureGrid();
    }
    const grid = computeGrid(m);
    if (!grid) break;                                            // aún no medible: no resizeamos…
    if (grid.cols === _term.cols && grid.rows === _term.rows) break;
    try { _term.resize(grid.cols, grid.rows); } catch { break; }
  }
  // …pero SIEMPRE reconciliamos: el caso que nos mordía es justo "la rejilla ya está bien y el PTY no".
  // Al colgarlo del final de _fitNow, TODAS las pasadas quedan cubiertas de un golpe: la síncrona, las
  // diferidas de _scheduleFit (rAF, rAF², 0ms, 150ms), el re-fit por `document.fonts.ready`, el
  // ResizeObserver del contenedor y el `window.resize`.
  _reconcilePtySize();
}

/**
 * Re-fit ahora + en los instantes en que la medida cambia por su cuenta. Hace falta porque la re-medición de
 * la celda que xterm hace al volverse visible corre en su IntersectionObserver, que es ASÍNCRONO: un solo
 * `_fitNow()` síncrono llega con la celda todavía en 0 y no ajusta nada. Es idempotente (si cols/rows no
 * cambian no llama a resize → el PTY no recibe SIGWINCH de más).
 */
function _scheduleFit() {
  _fitNow();
  try {
    requestAnimationFrame(() => { _fitNow(); requestAnimationFrame(() => _fitNow()); });
  } catch { /* sin rAF: quedan los timers */ }
  setTimeout(_fitNow, 0);
  setTimeout(_fitNow, 150);
}

/** Abre el PTY: monta xterm, hace fit, conecta el WS con las dims medidas. Devuelve true si arrancó el intento. */
function _openPty() {
  // VISIBLE ANTES de construir el emulador: `term.open()` sobre `display:none` mide la celda en 0 y deja la
  // rejilla clavada en 80×24 (todo `fit` posterior aborta al ver celda 0). Si el PTY falla, el caller y los
  // handlers de error devuelven el modo a 'oneshot'; el parpadeo es de un tick y del mismo color de fondo.
  _showMode('pty');
  const term = _ensureTerm();
  if (!term) return false;
  // Cierra el ciclo anterior ANTES del primer fit: `_scheduleFit()` reconcilia, y sin esto ese primer
  // reconcile podría escribirle a un socket viejo. (`born()` va después porque necesita las dims ya fiteadas.)
  _ptySize.closed();
  _scheduleFit();
  // El PTY nacerá con estas dims (el wrapper las aplica con `stty` dentro del pty) → cuentan como ENVIADAS.
  // No esperamos a un fit "bueno" para construir la URL: en este instante la celda puede no ser medible
  // todavía (fuente sin cargar) y bloquear el arranque por eso sería peor. El reconciliador se encarga de
  // converger después — que es precisamente para lo que existe.
  const cols = term.cols || 80, rows = term.rows || 24;
  _ptySize.born({ cols, rows });
  let ws;
  try { ws = new WebSocket(_wsUrl(cols, rows)); } catch { return false; }
  ws.binaryType = 'arraybuffer';
  _ws = ws;
  ws.onopen = () => {
    _ptyConnected = true;
    _gotOutput = false;
    _ptyOpenedAt = Date.now();
    _showMode('pty');
    // Abre el canal y empuja de una lo que la rejilla mida AHORA (pudo cambiar mientras el WS conectaba,
    // y esos `onResize` se descartaron por no haber canal). Luego el re-fit: cada una de sus pasadas
    // —incluidas las diferidas— reconcilia sola, así que no hacen falta timers de sincronización propios.
    _ptySize.opened(_gridSize());
    _scheduleFit();
    term.focus();
  };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      _gotOutput = true;
      term.write(new Uint8Array(ev.data));          // salida cruda del PTY
    } else if (typeof ev.data === 'string') {
      try {
        const o = JSON.parse(ev.data);
        // PTY murió instantáneo SIN emitir nada (p. ej. `script` no está en el contenedor) → degrada a one-shot
        // en vez de dejar al usuario atorado en un xterm con solo un [error].
        if ((o.type === 'error' || o.type === 'exit') && !_gotOutput && (Date.now() - _ptyOpenedAt) < 2500) {
          _ptyConnected = false;
          try { ws.close(); } catch { /* */ }
          _showMode('oneshot');
          const { output, input } = _els();
          if (output) _appendLine(output, '[terminal interactiva no disponible aquí — modo comando]\n', 'term-exit');
          if (input) input.focus();
          return;
        }
        if (o.type === 'error') term.write(`\r\n\x1b[31m[error] ${o.error || 'desconocido'}\x1b[0m\r\n`);
        else if (o.type === 'exit') term.write(`\r\n\x1b[90m[sesión terminada (exit ${o.code})]\x1b[0m\r\n`);
      } catch { /* control ilegible */ }
    }
  };
  ws.onclose = () => {
    _ptyConnected = false;
    _ptySize.closed();   // sin canal no se manda nada; el próximo _openPty hace `born()` con las dims nuevas
    if (_term) { try { _term.write('\r\n\x1b[90m[desconectado — reabre la terminal para reconectar]\x1b[0m\r\n'); } catch { /* */ } }
  };
  ws.onerror = () => {
    // Si NUNCA llegó a abrir, degradamos a one-shot. Si ya estaba abierto, onclose maneja el cierre.
    if (!_ptyConnected && !_ptyReady) { _showMode('oneshot'); }
  };
  _ptyReady = true;
  return true;
}

// ─────────────────────────────── modo ONE-SHOT (degradado) ───────────────────────────────
// Fallback fiel al comportamiento previo: POST /api/axon/term con SSE, texto crudo en <pre>. Solo se usa si el
// PTY no está disponible. (Se mantiene simple; sin ANSI.)

let _running = false, _controller = null;

function _appendLine(output, text, cls) {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  output.appendChild(span);
  output.scrollTop = output.scrollHeight;
}
function _setRunning(running) {
  _running = running;
  const { input, runBtn, stopBtn } = _els();
  if (input) input.disabled = running;
  if (runBtn) runBtn.disabled = running;
  if (stopBtn) stopBtn.classList.toggle('hidden', !running);
  if (!running && input) input.focus();
}
function _parseRecord(record) {
  const lines = record.split('\n');
  let isError = false, dataLine = null;
  for (const line of lines) {
    if (line.startsWith('event: error')) isError = true;
    else if (line.startsWith('data:')) dataLine = line.slice(5).trim();
  }
  if (dataLine == null) return null;
  if (dataLine === '[DONE]') return { done: true };
  try { return { isError, payload: JSON.parse(dataLine) }; } catch { return null; }
}
async function _runCommandOneShot(cmd) {
  const { output } = _els();
  if (!output) return;
  _appendLine(output, `\n$ ${cmd}\n`, 'term-cmd');
  _setRunning(true);
  _controller = new AbortController();
  try {
    const res = await fetch('/api/axon/term', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, session: _session }), signal: _controller.signal,
    });
    if (!res.ok || !res.body) { _appendLine(output, `[error] HTTP ${res.status}\n`, 'term-stderr'); return; }
    const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const record = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const parsed = _parseRecord(record);
        if (!parsed || parsed.done) continue;
        const { isError, payload } = parsed;
        if (isError) _appendLine(output, `[error] ${(payload && payload.error) || 'unknown error'}\n`, 'term-stderr');
        else if (payload && payload.type === 'stdout') _appendLine(output, payload.chunk, null);
        else if (payload && payload.type === 'stderr') _appendLine(output, payload.chunk, 'term-stderr');
        else if (payload && payload.type === 'exit') _appendLine(output, `[exit ${payload.code}]\n`, 'term-exit');
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') _appendLine(output, '[detenido]\n', 'term-exit');
    else _appendLine(output, `[error] ${(e && e.message) || String(e)}\n`, 'term-stderr');
  } finally { _controller = null; _setRunning(false); }
}

// ─────────────────────────────── UI ───────────────────────────────

/** Muestra el modo activo: 'pty' (xterm visible, input oculto) o 'oneshot' (input visible, xterm oculto). */
function _showMode(mode) {
  const { xterm, oneshot } = _els();
  if (xterm) xterm.classList.toggle('hidden', mode !== 'pty');
  if (oneshot) oneshot.classList.toggle('hidden', mode === 'pty');
}

function _clear() {
  if (_ptyConnected && _term) { try { _term.clear(); } catch { /* */ } return; }
  const { output, input } = _els();
  if (output) output.textContent = '';
  if (input) input.focus();
}

function _wire() {
  if (_wired) return;
  const { modal, input, runBtn, stopBtn, clearBtn } = _els();
  if (!modal) return;
  _wired = true;

  const content = modal.querySelector('.modal-content');
  const header = modal.querySelector('.modal-header');
  if (content && header) makeWindowDraggable(modal, { content, header, skipSelector: 'button, input, select' });

  // one-shot submit
  const submit = () => {
    if (_running) return;
    const cmd = (input && input.value || '').trim();
    if (!cmd) return;
    input.value = '';
    _runCommandOneShot(cmd);
  };
  if (runBtn) runBtn.addEventListener('click', submit);
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  if (stopBtn) stopBtn.addEventListener('click', () => { if (_controller) _controller.abort(); });
  if (clearBtn) clearBtn.addEventListener('click', _clear);

  // re-fit cuando el contenedor cambia de tamaño (drag-resize del modal) o pasa de oculto a visible (0×0 →
  // W×H también es un cambio de tamaño). SIN condicionar a `_ptyConnected`: el primer ajuste bueno cae justo
  // antes de que el WS abra, y perdérselo dejaba la rejilla mal hasta el siguiente resize manual.
  if (typeof ResizeObserver === 'function') {
    const { xterm } = _els();
    if (xterm) { _resizeObs = new ResizeObserver(() => _fitNow()); _resizeObs.observe(xterm); }
  }
  window.addEventListener('resize', () => _fitNow());
}

function open() {
  _wire();
  const { modal, input } = _els();
  if (!modal) return;
  modal.classList.remove('hidden');
  void _refreshBadge();

  // Intenta PTY. Si ya hay uno conectado (reabrir el modal sin cerrarlo), solo re-fit + focus.
  if (_ptyConnected) { _showMode('pty'); setTimeout(() => { _scheduleFit(); if (_term) _term.focus(); }, 0); return; }

  // Reset del flag por-apertura y arranca el intento tras un tick (el modal ya es visible → el contenedor mide).
  _ptyReady = false;
  setTimeout(() => {
    const started = _xtermAvailable() && _openPty();
    if (!started) { _showMode('oneshot'); if (input) input.focus(); }
  }, 0);
}

const terminalModule = { open };
export default terminalModule;
