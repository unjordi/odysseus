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
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// INSTANCIAS, NO SINGLETON (roadmap #29(a), 2026-09-08). Este archivo ERA un singleton: `let _ws`, un `_term`,
// un `#term-modal` y —lo más filoso— UN reconciliador de tamaño en variable de módulo. Nada de eso era una
// limitación del servidor: el PTY es por CONEXIÓN (`WS /api/axon/term/pty`) y aguanta N sin tocarse. El
// bloqueo era puramente de este frontend.
//
// AHORA: todo ese estado vive en un OBJETO POR INSTANCIA (`inst`), identificado por un **id explícito** que es
// TAMBIÉN el id del elemento del DOM — `term-modal` la primera (el nodo de `index.html`, con todo su CSS y su
// cableado en `app.js` intactos) y `term-modal--2`, `--3`… los CLONES. La contabilidad pura (ids, registro con
// orden de uso, bolsa de disposers, cascada) vive en `./term-instances.js`, con probe offline.
//
// LO QUE SIGUE SIENDO GLOBAL, y por qué:
//   · el listener de `window.resize` — UNO que le hace fit a todas; N listeners para el mismo evento son N
//     veces el mismo trabajo y N cosas que desenganchar.
//   · el badge de alcance (`host`/`container`/`host-down`) — describe a AXON, no a una ventana: se consulta
//     una vez y se pinta en todas.
//   · el id de sesión del modo one-shot por PESTAÑA — del que cada instancia deriva el suyo (ver
//     `sessionIdFor`), porque el one-shot del servidor SÍ está keyed por sesión.
// Todo lo demás —ws, xterm, elementos, addons, observers, reconciliador, estado del one-shot— es por instancia.
//
// CERRAR ≠ DESTRUIR (se conserva el comportamiento que ya existía): la ✕ OCULTA la ventana y el PTY SIGUE
// VIVO, así que reabrir te devuelve tu `claude` corriendo. La destrucción real (socket cerrado, xterm
// dispuesto, observers desenganchados, clon fuera del DOM) es `destroy(id)`.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
// GEOMETRÍA: las decisiones que se rompieron en producción viven PURAS en `./term-geometry.js`, para poder
// probarlas sin navegador (`node scratch/pty-frontend/probe-term-ui.mjs`, exit 0 = verde): cuántas cols/rows
// caben en el área visible (`computeGrid`) y qué tamaño mandarle al PTY y cuándo (`createPtySizeReconciler`).
//
// ANCHO DE COLUMNA — LO QUE SE PINTA MANDA, NO LO QUE XTERM CREE: `dimensions.css.cell.width` puede NO ser el
// paso con el que el navegador pinta. xterm mide el glifo en un contenedor oculto y cuadra la diferencia con
// un `letter-spacing` inline en `.xterm-rows`; si algo HEREDADO contamina esa medición, cada columna se pinta
// más ancha y el error se acumula hasta que el `overflow: hidden` del contenedor recorta las últimas
// columnas. El CSS corta la herencia (`.term-xterm .xterm { letter-spacing: normal }`) y aquí se MIDE el paso
// real (`_measurePaintedCellWidth`) como red — ver ambos comentarios.
//
// TAMAÑO DEL PTY — RECONCILIAR, NO NOTIFICAR: el shell debe creer EXACTAMENTE el tamaño que xterm rendea.
// Avisarle "cuando pase un evento" no alcanza (el PTY nace con las dims de la URL del WS, los resize
// anteriores a `onopen` se descartan, y el fit es idempotente → si la rejilla ya está bien nada vuelve a
// disparar). Aquí se GUARDA lo último enviado y se compara contra la rejilla en cada fit — ver
// `createPtySizeReconciler`. **Uno POR INSTANCIA**: era una variable de módulo, y con N terminales eso
// significaba que el fit de una le sobreescribía a la otra su "último enviado" → la otra dejaba de mandar
// resizes que sí hacían falta (o mandaba los de su vecina). Es el estado que más gritaba "esto es un
// singleton".

import { makeWindowDraggable } from './windowDrag.js';
import { computeGrid, createPtySizeReconciler, shouldSuppressInputEvent } from './term-geometry.js';
import { nextToolWindowZ } from './toolWindowZOrder.js';
import {
  PRIMARY_ID, createInstanceRegistry, createDisposerBag, cascadePosition, sessionIdFor,
} from './term-instances.js';

// ─────────────────────────────── estado GLOBAL (lo poco que lo es) ───────────────────────────────

/** Instancias VIVAS, con orden de uso (la última tocada al final). */
const _reg = createInstanceRegistry();

/** Clon PRISTINO del nodo de index.html, capturado ANTES de montar nada: de ahí salen los clones. */
let _tpl = null;

/** El `window.resize` se engancha UNA vez para todas (ver la nota de arriba). */
let _globalWired = false;

/**
 * Badge de ALCANCE de la terminal — CACHÉ COMPARTIDA. TRES estados, porque axon SONDEA al broker en vez de
 * deducir el modo de que las env estén puestas (`GET /api/axon/term/mode`):
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
 *
 * Es GLOBAL porque describe a AXON, no a una ventana: abrir la quinta terminal no vuelve a preguntar, y
 * cuando la respuesta llega se pinta en TODAS las que estén abiertas.
 */
const _badge = { fetched: false, mode: 'container', detail: '', inflight: null };

/** `session` id estable por PESTAÑA (base del one-shot; cada instancia deriva el suyo — ver sessionIdFor). */
const _baseSession = (() => {
  const mk = () => 'term-' + ((globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2));
  try {
    let s = sessionStorage.getItem('axon-term-session');
    if (!s) { s = mk(); sessionStorage.setItem('axon-term-session', s); }
    return s;
  } catch { return mk(); }
})();

// ─────────────────────────────── el DOM de una instancia ───────────────────────────────

/**
 * Elementos de UNA instancia, resueltos POR CLASE dentro de su propia raíz.
 *
 * Antes era `getElementById` — la definición misma del singleton: `#term-xterm` solo puede existir una vez en
 * el documento, así que la segunda terminal habría escrito sobre el emulador de la primera. Buscar por clase
 * DENTRO de la raíz hace que cada ventana solo se vea a sí misma. Los ids siguen existiendo (sufijados en los
 * clones) para quien direcciona ventanas por id — `app.js`, el `winsize-<id>` de `windowResize` — pero este
 * módulo ya no los usa para nada más que identificar la raíz.
 */
function _elsOf(root) {
  return {
    modal: root,
    content: root.querySelector('.modal-content'),
    header: root.querySelector('.modal-header'),
    badge: root.querySelector('.term-scope-badge'),
    xterm: root.querySelector('.term-xterm'),      // contenedor del emulador (modo PTY)
    oneshot: root.querySelector('.term-oneshot'),  // contenedor del modo degradado (input + <pre>)
    output: root.querySelector('.term-output'),
    input: root.querySelector('.term-input'),
    runBtn: root.querySelector('.term-run-btn'),
    stopBtn: root.querySelector('.term-stop-btn'),
    clearBtn: root.querySelector('.term-clear-btn'),
    newBtn: root.querySelector('.term-new-btn'),
  };
}

/**
 * Captura el molde: un clon PRISTINO del `#term-modal` de index.html, tomado antes de que nadie monte un
 * xterm adentro. Clonar el nodo VIVO traería el DOM del emulador de la primera terminal.
 */
function _ensureTemplate() {
  if (_tpl) return _tpl;
  const primary = document.getElementById(PRIMARY_ID);
  if (!primary) return null;
  _tpl = primary.cloneNode(true);
  return _tpl;
}

/**
 * La raíz de una instancia: el nodo estático para la primaria, un CLON con todos sus ids sufijados para las
 * demás. Sufijar los ids del clon no es cosmético: dos elementos con el mismo id no rompen el CSS (que ya es
 * por clase) pero sí `getElementById`, y ahí gana siempre el PRIMERO del documento — la segunda terminal
 * habría quedado invisible para todo el cableado por id.
 */
function _makeRoot(id) {
  if (id === PRIMARY_ID) return document.getElementById(PRIMARY_ID);
  const tpl = _ensureTemplate();
  if (!tpl) return null;
  const node = tpl.cloneNode(true);
  const suffix = id.slice(PRIMARY_ID.length);
  node.id = id;
  try { node.querySelectorAll('[id]').forEach((el) => { el.id = `${el.id}${suffix}`; }); } catch { /* */ }
  node.classList.add('hidden');
  document.body.appendChild(node);
  return node;
}

// ─────────────────────────────── ciclo de vida de una instancia ───────────────────────────────

function _isVisible(inst) {
  const el = inst && inst.root;
  if (!el) return false;
  if (el.classList.contains('hidden') || el.classList.contains('modal-minimized')) return false;
  try { return getComputedStyle(el).display !== 'none'; } catch { return true; }
}

/** Sube esta ventana por encima de las demás (mismo contador que usa el resto del shell). */
function _raise(inst) {
  if (!inst || !inst.root) return;
  try {
    inst.root.style.zIndex = String(nextToolWindowZ({ current: inst.root.style.zIndex, exclude: inst.root }));
  } catch { /* sin z: la ventana sigue usable, solo puede quedar debajo */ }
}

/**
 * Crea la instancia: su raíz, su estado, su reconciliador. NO abre el PTY (eso es `_reveal`).
 * Devuelve null si no hay DOM del que colgarse.
 */
function _createInstance(id) {
  const root = _makeRoot(id);
  if (!root) return null;
  const inst = {
    id,
    root,
    els: _elsOf(root),
    session: sessionIdFor(_baseSession, id),
    // PTY (modo interactivo)
    term: null,            // instancia de xterm.js
    ws: null,              // WebSocket del PTY
    ptyConnected: false,
    ptyReady: false,       // ya intentamos abrir PTY al menos una vez este open()
    gotOutput: false,      // ¿el PTY emitió algo? (para degradar si muere instantáneo, p. ej. sin `script`)
    ptyOpenedAt: 0,
    resizeObs: null,
    flushTimer: null,      // el `schedule` del reconciliador (uno por instancia, se cancela al destruir)
    // modo ONE-SHOT (degradado)
    running: false,
    controller: null,
    // ciclo de vida
    wired: false,
    destroyed: false,
    bag: createDisposerBag(),
    ptySize: null,
  };
  // Único emisor de `{type:'resize'}` hacia el PTY DE ESTA INSTANCIA. Recuerda lo último entregado (incluidas
  // las dims con las que el PTY NACIÓ vía la URL del WS) y solo manda cuando difiere de la rejilla → converge
  // sin depender de que un evento dispare en el momento correcto, y en reposo no manda NADA (cero SIGWINCH de
  // más). Vive en `inst` y no en el módulo: con N terminales, un "último enviado" compartido haría que el fit
  // de una silenciara los resizes legítimos de la otra.
  inst.ptySize = createPtySizeReconciler({
    send: ({ cols, rows }) => {
      if (!inst.ws || !inst.ptyConnected) return false;              // sin canal: no se entregó, se reintenta
      try { inst.ws.send(JSON.stringify({ type: 'resize', cols, rows })); return true; } catch { return false; }
    },
    // Coalesce la RÁFAGA de fits en UN frame. No es cosmético: del otro lado cada resize se aplica con un
    // `execFile("stty", ["-F", pts, …])` fire-and-forget SIN serializar (src/server/pty-session.ts), así que
    // dos frames con microsegundos de diferencia son dos `stty` en carrera y puede ganar el intermedio. 60 ms
    // cubre la ráfaga de apertura (síncrono + rAF + rAF² + 0 ms) sin que se note, y durante un drag del modal
    // actúa como throttle con el valor más fresco (≈16 SIGWINCH/s en vez de 60).
    schedule: (flush) => {
      if (inst.destroyed) return;
      inst.flushTimer = setTimeout(() => { inst.flushTimer = null; flush(); }, 60);
    },
  });
  _reg.add(id, inst);
  return inst;
}

/**
 * DESTRUCCIÓN de verdad: cierra el socket, dispone el emulador, suelta observers y listeners, y saca el clon
 * del DOM. Idempotente.
 *
 * Es el contrato que hace honesto lo de "abrir y cerrar N veces no deja nada colgando": todo lo que se
 * enganchó pasó por `inst.bag`, y aquí se suelta en bloque. El nodo de la instancia PRIMARIA no se borra
 * —viene del HTML— pero sí se limpia y se oculta, para que un `open()` posterior lo reuse desde cero.
 */
function destroy(id) {
  const inst = _reg.get(id);
  if (!inst) return false;
  inst.destroyed = true;
  _reg.remove(id);
  if (inst.flushTimer) { try { clearTimeout(inst.flushTimer); } catch { /* */ } inst.flushTimer = null; }
  if (inst.controller) { try { inst.controller.abort(); } catch { /* */ } inst.controller = null; }
  try { inst.ptySize.closed(); } catch { /* */ }
  if (inst.resizeObs) { try { inst.resizeObs.disconnect(); } catch { /* */ } inst.resizeObs = null; }
  inst.bag.disposeAll();
  if (inst.ws) {
    // Los handlers se sueltan ANTES de cerrar: el `onclose` de un socket que estamos matando a propósito no
    // debe escribirle "[desconectado]" a un xterm que ya vamos a disponer.
    try { inst.ws.onopen = inst.ws.onmessage = inst.ws.onclose = inst.ws.onerror = null; } catch { /* */ }
    try { inst.ws.close(); } catch { /* */ }
    inst.ws = null;
  }
  inst.ptyConnected = false;
  if (inst.term) { try { inst.term.dispose(); } catch { /* */ } inst.term = null; }
  const { xterm } = inst.els;
  if (xterm) { try { xterm.innerHTML = ''; } catch { /* */ } }
  if (inst.root) {
    inst.root.classList.add('hidden');
    if (id !== PRIMARY_ID) { try { inst.root.remove(); } catch { /* */ } }
  }
  return true;
}

// ─────────────────────────────── badge ───────────────────────────────

function _paintBadge(inst) {
  const badge = inst && inst.els && inst.els.badge;
  if (!badge) return;
  const mode = _badge.mode;
  badge.textContent = mode === 'host-down' ? 'host ⚠' : mode;
  badge.classList.toggle('host', mode === 'host');
  badge.classList.toggle('host-down', mode === 'host-down');
  badge.classList.toggle('container', mode === 'container');
  badge.title = mode === 'host'
    ? 'Corre en tu HOST (vía el broker de axon), como tú — ver docs/terminal.md'
    : mode === 'host-down'
      ? `El broker del host está configurado pero NO responde: los comandos van a fallar (no se cae al shell del contenedor a propósito — sería otra máquina). ${_badge.detail}`.trim()
      : 'Corre dentro del contenedor de axon (cwd del maincar), no en tu host — ver docs/terminal.md';
}

/** Sondea el modo (una vez, compartido) y lo pinta en TODAS las instancias vivas. */
async function _refreshBadge(inst) {
  if (_badge.fetched) { _paintBadge(inst); return; }
  if (!_badge.inflight) {
    _badge.inflight = (async () => {
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
      if (ok && mode !== 'host-down') _badge.fetched = true;
      _badge.mode = mode; _badge.detail = detail;
      _badge.inflight = null;
      for (const i of _reg.all()) _paintBadge(i);
    })();
  }
  try { await _badge.inflight; } catch { /* */ }
  _paintBadge(inst);
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

/** Tamaño ACTUAL de la rejilla de xterm de ESTA instancia (lo que el usuario ve), o null si no hay emulador. */
function _gridSize(inst) { return inst.term ? { cols: inst.term.cols, rows: inst.term.rows } : null; }

/** Reconcilia PTY↔rejilla. Never-throws: un send fallido jamás puede tumbar el widget. */
function _reconcilePtySize(inst) { try { inst.ptySize.reconcile(_gridSize(inst)); } catch { /* */ } }

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
 *
 * CON N INSTANCIAS: el listener se acota al textarea de ESTA terminal (`ev.target !== ta` → return), y se
 * REGISTRA EN LA BOLSA para poder soltarlo al destruirla. Antes no se soltaba nunca; con una sola terminal
 * eterna no se notaba, con N abriendo y cerrando sería un listener nuevo en cada apertura.
 */
function _wireCompositionGuard(inst, term, container) {
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
  try {
    host.addEventListener('input', onInputCapture, true);
    inst.bag.add(() => { try { host.removeEventListener('input', onInputCapture, true); } catch { /* */ } });
  } catch { /* sin captura: queda el bug, no un crash */ }
}

/**
 * Crea (una vez POR INSTANCIA) la instancia de xterm y la monta en el `.term-xterm` de ESA ventana.
 * PRE-REQUISITO: el contenedor ya debe estar VISIBLE. `term.open()` sobre un contenedor `display:none` mide
 * la celda como 0×0, y todo ajuste posterior aborta al ver celda 0 → la rejilla se queda en 80×24 (ver `_openPty`).
 */
function _ensureTerm(inst) {
  if (inst.term) return inst.term;
  const { xterm } = inst.els;
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
  _wireCompositionGuard(inst, term, xterm);
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
  // La guarda `inst.term === term` es la que evita que una promesa de una terminal ya destruida (o de un
  // emulador reemplazado) le haga fit a la que ocupó su lugar — un `.then()` no se puede desenganchar.
  try {
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { if (!inst.destroyed && inst.term === term) _scheduleFit(inst); }).catch(() => {});
    }
  } catch { /* sin FontFaceSet: la fuente cargará y el próximo resize re-fitea */ }
  // teclado del usuario → stdin del PTY (bytes crudos; xterm ya traduce Enter/Ctrl-C/flechas a las secuencias).
  term.onData((data) => {
    if (inst.ws && inst.ptyConnected) { try { inst.ws.send(new TextEncoder().encode(data)); } catch { /* ws cerrado */ } }
  });
  // resize del emulador → reconcilia (NO manda directo: el reconciliador es el único emisor, para que
  // "lo último enviado" nunca mienta). Es una de varias entradas, no la única: `onResize` solo dispara si
  // `term.resize()` CAMBIÓ algo, y el desfase que sufríamos vivía justo donde no cambiaba nada.
  term.onResize(() => _reconcilePtySize(inst));
  inst.term = term;
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
 * herencia (`.term-xterm .xterm { letter-spacing: normal }`); esta medición es la RED: mide lo que de verdad
 * se pinta, venga el desajuste de donde venga (una fuente que carga tarde, otro estilo heredado mañana).
 *
 * El probe se cuelga del PADRE de `.xterm-rows` (`.xterm-screen`), NUNCA de `.xterm-rows`: sus hijos los
 * indexa el renderer por posición y meterle uno propio le rompería el mapeo de filas. Copia las propiedades
 * de texto computadas de las filas —no hereda—, así mide exactamente el mismo paso que ellas.
 */
function _measurePaintedCellWidth(inst) {
  try {
    const rowsEl = inst.term && inst.term.element ? inst.term.element.querySelector('.xterm-rows') : null;
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
function _resyncCharMetrics(inst) {
  try {
    const core = inst.term && inst.term._core;
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
function _measureGrid(inst) {
  const { xterm } = inst.els;
  if (!xterm || !inst.term) return null;
  const core = inst.term._core;
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
  const viewportEl = inst.term.element ? inst.term.element.querySelector('.xterm-viewport') : null;
  // Ancho que la scrollbar le quita al texto. Con `scrollbar-gutter: stable` (ver `.term-xterm` en
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
    paintedCellWidth: _measurePaintedCellWidth(inst),
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
function _fitNow(inst) {
  if (!inst || inst.destroyed || !inst.term) return;
  let resynced = false;
  for (let i = 0; i < 3; i++) {
    let m = _measureGrid(inst);
    // Si lo pintado y lo declarado no coinciden, primero se intenta CERRAR la divergencia (una sola vez por
    // pasada, para no rebotar) y se vuelve a medir; lo que quede lo absorbe `computeGrid` con el paso mayor.
    if (m && !resynced && m.paintedCellWidth > 0 && Math.abs(m.paintedCellWidth - m.cellWidth) > 0.01) {
      resynced = true;
      if (_resyncCharMetrics(inst)) m = _measureGrid(inst);
    }
    const grid = computeGrid(m);
    if (!grid) break;                                            // aún no medible: no resizeamos…
    if (grid.cols === inst.term.cols && grid.rows === inst.term.rows) break;
    try { inst.term.resize(grid.cols, grid.rows); } catch { break; }
  }
  // …pero SIEMPRE reconciliamos: el caso que nos mordía es justo "la rejilla ya está bien y el PTY no".
  // Al colgarlo del final de _fitNow, TODAS las pasadas quedan cubiertas de un golpe: la síncrona, las
  // diferidas de _scheduleFit (rAF, rAF², 0ms, 150ms), el re-fit por `document.fonts.ready`, el
  // ResizeObserver del contenedor y el `window.resize`.
  _reconcilePtySize(inst);
}

/**
 * Re-fit ahora + en los instantes en que la medida cambia por su cuenta. Hace falta porque la re-medición de
 * la celda que xterm hace al volverse visible corre en su IntersectionObserver, que es ASÍNCRONO: un solo
 * `_fitNow()` síncrono llega con la celda todavía en 0 y no ajusta nada. Es idempotente (si cols/rows no
 * cambian no llama a resize → el PTY no recibe SIGWINCH de más).
 *
 * Cada pasada diferida re-chequea `inst.destroyed`: la ventana se puede cerrar entre el rAF y el timer de
 * 150 ms, y medir/resizear un emulador ya dispuesto es la clase de error que solo se ve en consola.
 */
function _scheduleFit(inst) {
  _fitNow(inst);
  try {
    requestAnimationFrame(() => { _fitNow(inst); requestAnimationFrame(() => _fitNow(inst)); });
  } catch { /* sin rAF: quedan los timers */ }
  setTimeout(() => _fitNow(inst), 0);
  setTimeout(() => _fitNow(inst), 150);
}

/** Abre el PTY: monta xterm, hace fit, conecta el WS con las dims medidas. Devuelve true si arrancó el intento. */
function _openPty(inst) {
  // VISIBLE ANTES de construir el emulador: `term.open()` sobre `display:none` mide la celda en 0 y deja la
  // rejilla clavada en 80×24 (todo `fit` posterior aborta al ver celda 0). Si el PTY falla, el caller y los
  // handlers de error devuelven el modo a 'oneshot'; el parpadeo es de un tick y del mismo color de fondo.
  _showMode(inst, 'pty');
  const term = _ensureTerm(inst);
  if (!term) return false;
  // Cierra el ciclo anterior ANTES del primer fit: `_scheduleFit()` reconcilia, y sin esto ese primer
  // reconcile podría escribirle a un socket viejo. (`born()` va después porque necesita las dims ya fiteadas.)
  inst.ptySize.closed();
  _scheduleFit(inst);
  // El PTY nacerá con estas dims (el wrapper las aplica con `stty` dentro del pty) → cuentan como ENVIADAS.
  // No esperamos a un fit "bueno" para construir la URL: en este instante la celda puede no ser medible
  // todavía (fuente sin cargar) y bloquear el arranque por eso sería peor. El reconciliador se encarga de
  // converger después — que es precisamente para lo que existe.
  const cols = term.cols || 80, rows = term.rows || 24;
  inst.ptySize.born({ cols, rows });
  let ws;
  try { ws = new WebSocket(_wsUrl(cols, rows)); } catch { return false; }
  ws.binaryType = 'arraybuffer';
  inst.ws = ws;
  // Todos los handlers salen por la puerta de `inst`: si esta instancia ya no es la dueña del socket (se
  // destruyó y el `close()` aún no llegó), lo que llegue tarde no toca nada.
  ws.onopen = () => {
    if (inst.destroyed || inst.ws !== ws) return;
    inst.ptyConnected = true;
    inst.gotOutput = false;
    inst.ptyOpenedAt = Date.now();
    _showMode(inst, 'pty');
    // Abre el canal y empuja de una lo que la rejilla mida AHORA (pudo cambiar mientras el WS conectaba,
    // y esos `onResize` se descartaron por no haber canal). Luego el re-fit: cada una de sus pasadas
    // —incluidas las diferidas— reconcilia sola, así que no hacen falta timers de sincronización propios.
    inst.ptySize.opened(_gridSize(inst));
    _scheduleFit(inst);
    term.focus();
  };
  ws.onmessage = (ev) => {
    if (inst.destroyed || inst.ws !== ws) return;
    if (ev.data instanceof ArrayBuffer) {
      inst.gotOutput = true;
      term.write(new Uint8Array(ev.data));          // salida cruda del PTY
    } else if (typeof ev.data === 'string') {
      try {
        const o = JSON.parse(ev.data);
        // PTY murió instantáneo SIN emitir nada (p. ej. `script` no está en el contenedor) → degrada a one-shot
        // en vez de dejar al usuario atorado en un xterm con solo un [error].
        if ((o.type === 'error' || o.type === 'exit') && !inst.gotOutput && (Date.now() - inst.ptyOpenedAt) < 2500) {
          inst.ptyConnected = false;
          try { ws.close(); } catch { /* */ }
          _showMode(inst, 'oneshot');
          const { output, input } = inst.els;
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
    if (inst.destroyed || inst.ws !== ws) return;
    inst.ptyConnected = false;
    inst.ptySize.closed();   // sin canal no se manda nada; el próximo _openPty hace `born()` con las dims nuevas
    if (inst.term) { try { inst.term.write('\r\n\x1b[90m[desconectado — reabre la terminal para reconectar]\x1b[0m\r\n'); } catch { /* */ } }
  };
  ws.onerror = () => {
    if (inst.destroyed || inst.ws !== ws) return;
    // Si NUNCA llegó a abrir, degradamos a one-shot. Si ya estaba abierto, onclose maneja el cierre.
    if (!inst.ptyConnected && !inst.ptyReady) { _showMode(inst, 'oneshot'); }
  };
  inst.ptyReady = true;
  return true;
}

// ─────────────────────────────── modo ONE-SHOT (degradado) ───────────────────────────────
// Fallback fiel al comportamiento previo: POST /api/axon/term con SSE, texto crudo en <pre>. Solo se usa si el
// PTY no está disponible. (Se mantiene simple; sin ANSI.) El `session` es POR INSTANCIA — dos terminales con
// el mismo id compartirían el shell del one-shot, que del lado de axon sí está keyed por sesión.

function _appendLine(output, text, cls) {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  output.appendChild(span);
  output.scrollTop = output.scrollHeight;
}
function _setRunning(inst, running) {
  inst.running = running;
  const { input, runBtn, stopBtn } = inst.els;
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
async function _runCommandOneShot(inst, cmd) {
  const { output } = inst.els;
  if (!output) return;
  _appendLine(output, `\n$ ${cmd}\n`, 'term-cmd');
  _setRunning(inst, true);
  inst.controller = new AbortController();
  try {
    const res = await fetch('/api/axon/term', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, session: inst.session }), signal: inst.controller.signal,
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
  } finally { inst.controller = null; if (!inst.destroyed) _setRunning(inst, false); }
}

// ─────────────────────────────── UI ───────────────────────────────

/** Muestra el modo activo: 'pty' (xterm visible, input oculto) o 'oneshot' (input visible, xterm oculto). */
function _showMode(inst, mode) {
  const { xterm, oneshot } = inst.els;
  if (xterm) xterm.classList.toggle('hidden', mode !== 'pty');
  if (oneshot) oneshot.classList.toggle('hidden', mode === 'pty');
}

function _clear(inst) {
  if (inst.ptyConnected && inst.term) { try { inst.term.clear(); } catch { /* */ } return; }
  const { output, input } = inst.els;
  if (output) output.textContent = '';
  if (input) input.focus();
}

/**
 * `window.resize` UNA vez para TODAS las instancias. Un listener por ventana sería N veces el mismo trabajo
 * en cada arrastre del borde del navegador, y N cosas que acordarse de desenganchar.
 */
function _wireGlobal() {
  if (_globalWired) return;
  _globalWired = true;
  window.addEventListener('resize', () => { for (const inst of _reg.all()) _fitNow(inst); });
}

function _wire(inst) {
  if (inst.wired) return;
  const { modal, content, header, input, runBtn, stopBtn, clearBtn, newBtn, xterm } = inst.els;
  if (!modal) return;
  inst.wired = true;
  _wireGlobal();

  if (content && header) makeWindowDraggable(modal, { content, header, skipSelector: 'button, input, select' });

  // Con varias ventanas del mismo tipo, la de arriba tiene que ser la que TOCAS: sin esto, la terminal en la
  // que estás escribiendo puede quedar debajo de otra y no hay forma de subirla. `touch` además fija a cuál
  // vuelve el botón del rail (la última que usaste, no una al azar).
  const onPointerDown = () => { _reg.touch(inst.id); _raise(inst); };
  modal.addEventListener('pointerdown', onPointerDown, true);
  inst.bag.add(() => { try { modal.removeEventListener('pointerdown', onPointerDown, true); } catch { /* */ } });

  // one-shot submit
  const submit = () => {
    if (inst.running) return;
    const cmd = (input && input.value || '').trim();
    if (!cmd) return;
    input.value = '';
    _runCommandOneShot(inst, cmd);
  };
  const onRun = () => submit();
  const onInputKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
  const onStop = () => { if (inst.controller) inst.controller.abort(); };
  const onClear = () => _clear(inst);
  const onNew = (e) => { e.preventDefault(); e.stopPropagation(); openNew(); };
  if (runBtn) { runBtn.addEventListener('click', onRun); inst.bag.add(() => runBtn.removeEventListener('click', onRun)); }
  if (input) { input.addEventListener('keydown', onInputKey); inst.bag.add(() => input.removeEventListener('keydown', onInputKey)); }
  if (stopBtn) { stopBtn.addEventListener('click', onStop); inst.bag.add(() => stopBtn.removeEventListener('click', onStop)); }
  if (clearBtn) { clearBtn.addEventListener('click', onClear); inst.bag.add(() => clearBtn.removeEventListener('click', onClear)); }
  if (newBtn) { newBtn.addEventListener('click', onNew); inst.bag.add(() => newBtn.removeEventListener('click', onNew)); }

  // re-fit cuando el contenedor cambia de tamaño (drag-resize del modal) o pasa de oculto a visible (0×0 →
  // W×H también es un cambio de tamaño). SIN condicionar a `ptyConnected`: el primer ajuste bueno cae justo
  // antes de que el WS abra, y perdérselo dejaba la rejilla mal hasta el siguiente resize manual.
  // UNO POR INSTANCIA, observando SU contenedor: un observer global no sabría a qué emulador hacerle fit.
  if (typeof ResizeObserver === 'function' && xterm) {
    inst.resizeObs = new ResizeObserver(() => _fitNow(inst));
    inst.resizeObs.observe(xterm);
    inst.bag.add(() => { if (inst.resizeObs) { try { inst.resizeObs.disconnect(); } catch { /* */ } inst.resizeObs = null; } });
  }
}

/**
 * Muestra la ventana y garantiza que tenga PTY. Es el cuerpo que antes vivía en `open()`: si ya hay un PTY
 * conectado (reabrir sin haber destruido), solo re-fit + focus; si no, arranca el intento tras un tick, ya
 * con el modal visible para que el contenedor mida.
 */
function _reveal(inst) {
  _wire(inst);
  inst.root.classList.remove('hidden', 'modal-minimized');
  _reg.touch(inst.id);
  _raise(inst);
  void _refreshBadge(inst);

  if (inst.ptyConnected) {
    _showMode(inst, 'pty');
    setTimeout(() => { if (inst.destroyed) return; _scheduleFit(inst); if (inst.term) inst.term.focus(); }, 0);
    return inst;
  }

  // Reset del flag por-apertura y arranca el intento tras un tick (el modal ya es visible → el contenedor mide).
  inst.ptyReady = false;
  setTimeout(() => {
    if (inst.destroyed) return;
    const started = _xtermAvailable() && _openPty(inst);
    if (!started) { _showMode(inst, 'oneshot'); if (inst.els.input) inst.els.input.focus(); }
  }, 0);
  return inst;
}

/** Coloca la ventana nueva en CASCADA respecto de la que ya estaba, para que no tape exactamente a su gemela. */
function _cascadeOver(inst, ref) {
  const target = inst.els.content, from = ref && ref.els.content;
  if (!target || !from) return;
  try {
    const pos = cascadePosition({
      rect: from.getBoundingClientRect(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    if (!pos) return;
    // Las MISMAS tres propiedades que fija el drag (`windowDrag._startDrag`), para no inventar un segundo
    // modelo de posición que después pelee con el arrastre.
    target.style.position = 'fixed';
    target.style.left = `${pos.left}px`;
    target.style.top = `${pos.top}px`;
  } catch { /* sin medida: que caiga centrada, como cualquier modal */ }
}

/**
 * SIEMPRE una terminal NUEVA (el botón `+` del encabezado). Cada una trae su propio PTY: del lado de axon eso
 * ya funcionaba —el PTY es por conexión—, lo que faltaba era que el frontend pudiera sostener más de una.
 */
function openNew() {
  _ensureTemplate();
  const prev = _reg.mostRecent((i) => _isVisible(i));
  const inst = _createInstance(_reg.nextFreeId());
  if (!inst) return null;
  if (prev) _cascadeOver(inst, prev);
  return _reveal(inst);
}

/**
 * El botón del rail/sidebar: "quiero mi terminal". Devuelve la que estabas usando en vez de crear otra —
 * abrir N terminales es un acto explícito (el `+`), no el efecto secundario de volver a picarle al ícono.
 *   1. ¿hay alguna oculta? re-muéstrala (con su PTY vivo: tu `claude` sigue ahí).
 *   2. ¿están todas visibles? sube al frente la última que usaste.
 *   3. ¿no hay ninguna? crea la primera.
 */
function open() {
  _ensureTemplate();
  const hidden = _reg.mostRecent((i) => !_isVisible(i));
  if (hidden) return _reveal(hidden);
  const visible = _reg.mostRecent((i) => _isVisible(i));
  if (visible) {
    _reg.touch(visible.id);
    _raise(visible);
    setTimeout(() => { if (!visible.destroyed) { _scheduleFit(visible); if (visible.term) visible.term.focus(); } }, 0);
    return visible;
  }
  return openNew();
}

/** Ids de las instancias vivas, de la más antigua a la más recientemente usada. */
function list() { return _reg.ids(); }

/** ¿Esta raíz del DOM es una terminal viva? (lo usa `app.js` para el cierre delegado). */
function isInstance(id) { return _reg.has(id); }

const terminalModule = { open, openNew, destroy, list, isInstance };
export default terminalModule;
