#!/usr/bin/env node
// scratch/pty-frontend/probe-term-instancias.mjs — probe OFFLINE de la TERMINAL EN VARIAS INSTANCIAS (#29a).
//
//   node scratch/pty-frontend/probe-term-instancias.mjs     # exit 0 = todo verde, exit 1 = alguna aserción falló
//
// HERMANO de `probe-term-ui.mjs`, que cubre la ARITMÉTICA pura (cuántas columnas caben, qué se le manda al
// PTY). Este cubre lo otro: el CICLO DE VIDA con N terminales abiertas — de quién es cada socket, a quién le
// llega cada resize, y qué queda colgando al cerrar. Eso no se puede probar con funciones puras, así que aquí
// se EJERCITA el módulo real (`static/js/terminal.js`) contra un DOM de mentiras (`./dom-stub.mjs`).
//
// LO QUE ESTE PROBE PUEDE AFIRMAR: que dos instancias tienen su propio ws/xterm/observer/reconciliador, que un
// resize de una NO se le manda a la otra, que cerrar (ocultar) una no toca a la otra, y que destruir una deja
// CERO sockets/observers/listeners huérfanos.
// LO QUE NO: nada visual. No hay CSS, ni layout, ni foco real. Que la segunda ventana se vea bien —y que el
// arreglo del ancho de columnas siga vivo en ella— es QA en navegador, y no se declara desde aquí.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  El, installDom, installResizeObserver, installWebSocket, installXterm, installFetch,
  observers, sockets, terminals, resizeContainer, sleep,
} from './dom-stub.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

let fallos = 0;
let corridas = 0;
function ok(cond, titulo, detalle) {
  corridas++;
  if (cond) { console.log(`  ✓ ${titulo}`); return true; }
  fallos++;
  console.log(`  ✗ ${titulo}`);
  if (detalle) console.log(`      ${detalle}`);
  return false;
}
const eq = (a, b, titulo) => ok(Object.is(a, b), titulo, `esperado ${JSON.stringify(b)}, obtenido ${JSON.stringify(a)}`);
const seccion = (t) => console.log(`\n${t}`);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 0. Las piezas PURAS de la contabilidad de instancias (sin DOM de por medio)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const {
  PRIMARY_ID, instanceIdFor, instanceSuffix, scopedId, sessionIdFor,
  createDisposerBag, createInstanceRegistry, cascadePosition,
} = await import(pathToFileURL(resolve(REPO, 'static/js/term-instances.js')).href);

seccion('term-instances · ids (el id de instancia ES el id del elemento)');
{
  eq(instanceIdFor(1), 'term-modal', 'la primera reusa el nodo de index.html');
  eq(instanceIdFor(3), 'term-modal--3', 'las demás llevan sufijo');
  eq(instanceSuffix('term-modal'), '', 'la primaria no sufija nada');
  eq(instanceSuffix('term-modal--7'), '--7', 'sufijo de la 7ª');
  eq(scopedId('term-xterm', 'term-modal--2'), 'term-xterm--2', 'los ids de dentro del clon también se sufijan');
  eq(scopedId('term-xterm', PRIMARY_ID), 'term-xterm', 'y en la primaria quedan EXACTAMENTE como estaban');
  eq(sessionIdFor('term-abc', 'term-modal'), 'term-abc', 'la sesión one-shot de la primaria no cambia (compat)');
  eq(sessionIdFor('term-abc', 'term-modal--2'), 'term-abc--2',
    'y la de otra instancia es DISTINTA: el one-shot del servidor está keyed por sesión');
}

seccion('term-instances · registro: orden de uso y reutilización de huecos');
{
  const reg = createInstanceRegistry();
  eq(reg.nextFreeId(), 'term-modal', 'con el registro vacío, el hueco libre es la primaria');
  reg.add('term-modal', { id: 'term-modal' });
  eq(reg.nextFreeId(), 'term-modal--2', 'ocupada la primaria, sigue la 2');
  reg.add('term-modal--2', { id: 'term-modal--2' });
  reg.add('term-modal--3', { id: 'term-modal--3' });
  eq(reg.size(), 3, 'tres instancias vivas');
  eq(reg.mostRecent().id, 'term-modal--3', 'la más reciente es la última agregada');
  reg.touch('term-modal');
  eq(reg.mostRecent().id, 'term-modal', 'tocar una la vuelve la más reciente (a esa vuelve el botón del rail)');
  reg.remove('term-modal--2');
  eq(reg.nextFreeId(), 'term-modal--2', 'el hueco liberado se REUSA (ids cortos en sesiones largas)');
  eq(reg.mostRecent((r) => r.id !== 'term-modal').id, 'term-modal--3', 'mostRecent respeta el predicado');
}

seccion('term-instances · bolsa de disposers (el antídoto al listener huérfano)');
{
  const orden = [];
  const bag = createDisposerBag();
  bag.add(() => orden.push('a'));
  bag.add(() => { throw new Error('este disposer truena'); });
  bag.add(() => orden.push('c'));
  eq(bag.size(), 3, 'tres disposers registrados');
  eq(bag.disposeAll(), 3, 'disposeAll corre los tres');
  eq(orden.join(','), 'c,a', 'en orden INVERSO, y el que truena no aborta a los demás');
  eq(bag.disposeAll(), 0, 'un segundo disposeAll no vuelve a correr nada (exactamente-una-vez)');
  let tardio = 0;
  bag.add(() => { tardio++; });
  eq(tardio, 1, 'registrar DESPUÉS de disponer ejecuta en el acto: nada queda colgando');
}

seccion('term-instances · cascada de la ventana nueva');
{
  const viewport = { width: 1600, height: 900 };
  const p = cascadePosition({ rect: { left: 100, top: 100, width: 760, height: 560 }, viewport });
  eq(p.left, 128, 'escalón de 28 px a la derecha');
  eq(p.top, 128, 'y 28 px abajo');
  const borde = cascadePosition({ rect: { left: 1500, top: 800, width: 760, height: 560 }, viewport });
  ok(borde.left <= viewport.width - 760 && borde.top <= viewport.height - 560,
    'cerca del borde la cascada REINICIA en vez de empujar el header fuera de la pantalla',
    JSON.stringify(borde));
  eq(cascadePosition({ rect: { left: NaN, top: 0, width: 1, height: 1 }, viewport }), null, 'medida inservible → null');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1. El módulo REAL contra el DOM de mentiras
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// `terminal.js` importa `./windowDrag.js` (arrastre/resize/dock del modal), que no es lo que se prueba aquí y
// arrastraría medio shell. Se sustituye por un no-op ANTES de importar, con el hook síncrono de Node.
const require = createRequire(import.meta.url);
const { registerHooks } = require('node:module');
const DRAG_PATH = resolve(REPO, 'static/js/windowDrag.js');
registerHooks({
  load(url, context, nextLoad) {
    if (fileURLToPath(url) === DRAG_PATH) {
      return { format: 'module', shortCircuit: true, source: 'export function makeWindowDraggable() {}' };
    }
    return nextLoad(url, context);
  },
});

// ── El nodo #term-modal se construye PARSEANDO static/index.html, no a mano ──
// Así el probe verifica también el CONTRATO html↔js: si alguien le quita una clase al markup (o `terminal.js`
// empieza a buscar otra), el `_elsOf` se queda sin ese elemento y las aserciones de abajo se caen. Un molde
// escrito a mano en el probe no podría detectar eso — se quedaría verde mintiendo.
const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'polyline', 'line', 'path', 'circle']);
function parseFragment(html) {
  const root = new El('root');
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [full, closeTag, openTag, attrs, selfClose, text] = m;
    if (full.startsWith('<!--')) continue;
    if (closeTag) { if (stack.length > 1) stack.pop(); continue; }
    if (openTag) {
      const el = new El(openTag);
      const ra = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
      let a;
      while ((a = ra.exec(attrs || '')) !== null) el.setAttribute(a[1], a[2]);
      stack[stack.length - 1].appendChild(el);
      if (!selfClose && !VOID_TAGS.has(openTag.toLowerCase())) stack.push(el);
      continue;
    }
    if (text && text.trim()) stack[stack.length - 1].textContent += text.trim();
  }
  return root.children[0];
}

function termModalFromIndexHtml() {
  const html = readFileSync(resolve(REPO, 'static/index.html'), 'utf8');
  const start = html.indexOf('<div id="term-modal"');
  if (start < 0) throw new Error('no se encontró #term-modal en static/index.html');
  // Escaneo de profundidad hasta el </div> que cierra el modal.
  let depth = 0, i = start;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let m;
  while ((m = re.exec(html)) !== null) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) { i = m.index + m[0].length; break; }
  }
  return parseFragment(html.slice(start, i));
}

/** Medidas del contenedor del emulador. Los px de padding son los del CSS (`padding: 6px 0 6px 8px`). */
function fijarMedidas(root, { width = 738, height = 500 } = {}) {
  const x = root.querySelector('.term-xterm');
  x.clientWidth = width; x.clientHeight = height;
  x.style.paddingLeft = '8px'; x.style.paddingRight = '0px';
  x.style.paddingTop = '6px'; x.style.paddingBottom = '6px';
  const content = root.querySelector('.modal-content');
  content._rect = { left: 100, top: 100, width: 760, height: 560 };
  return x;
}

const { doc, body } = installDom();
installResizeObserver();
installWebSocket();
installXterm();
installFetch('host');
const primary = termModalFromIndexHtml();
body.appendChild(primary);

seccion('contrato html↔js · el markup trae TODAS las clases que el widget busca');
{
  for (const cls of ['.modal-content', '.modal-header', '.term-scope-badge', '.term-xterm', '.term-oneshot',
    '.term-output', '.term-input', '.term-run-btn', '.term-stop-btn', '.term-clear-btn', '.term-new-btn']) {
    ok(!!primary.querySelector(cls), `index.html tiene ${cls}`);
  }
  ok(primary.classList.contains('term-modal'),
    'la raíz lleva la clase `term-modal` (por ahí la encuentran el CSS, el ESC y el cierre delegado)');
}

const terminalModule = (await import(pathToFileURL(resolve(REPO, 'static/js/terminal.js')).href)).default;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
seccion('abrir DOS terminales a la vez · cada una con su propio todo');
// ─────────────────────────────────────────────────────────────────────────────────────────────────
fijarMedidas(primary);
const a = terminalModule.open();
await sleep(250);                                   // deja correr toda la ráfaga de fits (rAF, 0 ms, 150 ms)
eq(a.id, 'term-modal', 'la primera instancia reusa el nodo estático');
eq(terminalModule.list().length, 1, 'una instancia viva');

const b = terminalModule.openNew();
fijarMedidas(b.root);                               // el clon nace sin medidas: se las fija el "layout"
await sleep(250);
eq(b.id, 'term-modal--2', 'la segunda es un clon con id sufijado');
eq(doc.getElementById('term-modal--2') === b.root, true, 'y está en el documento, direccionable por su id');
eq(doc.getElementById('term-xterm--2') !== null, true, 'los ids de DENTRO del clon también se sufijaron');
eq(doc.getElementById('term-xterm') === a.els.xterm, true, 'el de la primaria quedó intacto');
ok(a.els.xterm !== b.els.xterm, 'contenedores del emulador DISTINTOS');
ok(a.term && b.term && a.term !== b.term, 'emuladores xterm DISTINTOS');
ok(a.ws && b.ws && a.ws !== b.ws, 'WebSockets DISTINTOS (el PTY es por conexión: el servidor aguanta N)');
ok(a.ptySize !== b.ptySize, 'reconciliadores de tamaño DISTINTOS (era LA variable de módulo del singleton)');
ok(a.session !== b.session, 'ids de sesión del one-shot distintos');
eq(sockets.filter((s) => !s.closed).length, 2, 'dos PTYs vivos a la vez');
eq(a.ptyConnected && b.ptyConnected, true, 'las dos conectadas');
eq(observers.live.size, 2, 'un ResizeObserver por instancia, ni uno más');
eq(doc.listenerCount('resize'), 1, 'y UN solo listener de window.resize para todas (es global a propósito)');
eq(terminalModule.list().join(','), 'term-modal,term-modal--2', 'las dos en el registro');

// ─────────────────────────────────────────────────────────────────────────────────────────────────
seccion('los RESIZES no se pisan (el bug que traía el reconciliador de módulo)');
// ─────────────────────────────────────────────────────────────────────────────────────────────────
{
  const aFrames0 = a.ws.resizes().length, bFrames0 = b.ws.resizes().length;
  eq(aFrames0, 0, 'en reposo no se manda NADA (el PTY nació con las dims de su URL)');
  eq(bFrames0, 0, 'idem la segunda');

  // La ventana A se encoge: 738 → 418 px de caja.
  resizeContainer(a.els.xterm, { clientWidth: 418 });
  await sleep(150);
  const aF = a.ws.resizes(), bF = b.ws.resizes();
  eq(aF.length, 1, 'A manda UN frame de resize (la ráfaga se coalesce)');
  // `?? null` para que un frame ausente se REPORTE como aserción roja en vez de tumbar el probe con un
  // TypeError: una regresión tiene que salir en la lista, no en un stack trace.
  eq(aF[0]?.cols ?? null, 50, 'y con SUS columnas: (418 − 8 pad − 8 gap) / 8 = 50');
  eq(bF.length, 0, 'B NO recibe nada: el resize de una vecina no es suyo');
  eq(b.term.cols, 90, 'y la rejilla de B ni se movió');

  // Ahora la que se mueve es B, y A debe quedarse quieta.
  resizeContainer(b.els.xterm, { clientWidth: 338 });
  await sleep(150);
  eq(b.ws.resizes().length, 1, 'B manda su propio frame');
  eq(b.ws.resizes()[0]?.cols ?? null, 40, 'con SUS columnas: (338 − 16) / 8 = 40');
  eq(a.ws.resizes().length, 1, 'A sigue con UN solo frame (nadie le sobreescribió su "último enviado")');
  eq(a.term.cols, 50, 'y cada rejilla conserva su tamaño');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
seccion('CERRAR (✕ = ocultar) una no toca a la otra, y el PTY sigue vivo');
// ─────────────────────────────────────────────────────────────────────────────────────────────────
{
  a.root.classList.add('hidden');                   // exactamente lo que hace `dismissModal`
  await sleep(20);
  eq(a.ws.closed, false, 'cerrar la ventana NO mata el PTY (tu `claude` sigue corriendo)');
  eq(b.ptyConnected, true, 'la otra terminal sigue conectada');
  resizeContainer(b.els.xterm, { clientWidth: 738 });
  await sleep(150);
  eq(b.ws.resizes().length, 2, 'y sigue reconciliando su tamaño con normalidad');
  eq(b.ws.resizes()[1]?.cols ?? null, 90, 'con el valor nuevo');

  // Reabrir por el botón del rail devuelve la OCULTA (la que estabas usando), no una nueva.
  const vuelta = terminalModule.open();
  await sleep(60);
  eq(vuelta.id, 'term-modal', 'el rail re-muestra la instancia oculta');
  eq(terminalModule.list().length, 2, 'sin crear una tercera');
  eq(a.ws.closed, false, 'con su mismo socket: la sesión se reencuentra, no se reinicia');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
seccion('DESTRUIR una: cero sockets, observers y listeners huérfanos — y la otra sigue viva');
// ─────────────────────────────────────────────────────────────────────────────────────────────────
{
  const rootB = b.root, xtermB = b.els.xterm, termB = b.term, wsB = b.ws;
  const antesListeners = rootB.listenerCount('pointerdown');
  eq(antesListeners, 1, 'la ventana tenía su listener de traer-al-frente');

  eq(terminalModule.destroy('term-modal--2'), true, 'destroy devuelve true');
  eq(wsB.closed, true, 'su WebSocket quedó CERRADO');
  eq(termB.disposed, true, 'su emulador quedó dispuesto');
  eq(rootB.listenerCount('pointerdown'), 0, 'sus listeners se soltaron');
  eq(xtermB.listenerCount('input'), 0, 'incluido el guard de composición (acentos)');
  eq(observers.live.size, 1, 'su ResizeObserver se desenganchó (queda el de la otra)');
  eq(doc.getElementById('term-modal--2'), null, 'y el clon salió del DOM');
  eq(terminalModule.list().join(','), 'term-modal', 'el registro solo conserva la viva');

  // La superviviente no se enteró.
  eq(a.ptyConnected, true, 'la otra sigue conectada');
  resizeContainer(a.els.xterm, { clientWidth: 258 });
  await sleep(150);
  const aF = a.ws.resizes();
  eq(aF.length, 2, 'y sigue mandando SUS resizes');
  eq(aF[1]?.cols ?? null, 30, 'con su medida nueva: (258 − 16) / 8 = 30');
  eq(terminalModule.destroy('term-modal--2'), false, 'destruir dos veces es no-op');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
seccion('ABRIR → CERRAR → REABRIR en ciclo: nada se acumula');
// ─────────────────────────────────────────────────────────────────────────────────────────────────
{
  for (let i = 0; i < 3; i++) {
    const n = terminalModule.openNew();
    fijarMedidas(n.root);
    await sleep(60);
    terminalModule.destroy(n.id);
  }
  eq(terminalModule.list().join(','), 'term-modal', 'tras tres ciclos sigue habiendo UNA instancia');
  eq(observers.live.size, 1, 'un observer, no cuatro');
  eq(sockets.filter((s) => !s.closed).length, 1, 'un socket vivo, no cuatro');
  eq(doc.listenerCount('resize'), 1, 'el listener global sigue siendo UNO (no se re-engancha por instancia)');
  eq(terminals.filter((t) => !t.disposed).length, 1, 'un emulador vivo');

  const reuso = terminalModule.openNew();
  await sleep(60);
  eq(reuso.id, 'term-modal--2', 'la instancia nueva REUSA el hueco liberado');
  terminalModule.destroy(reuso.id);

  // Y destruir la PRIMARIA no borra su nodo (viene del HTML), pero sí la deja lista para reusarse.
  terminalModule.destroy('term-modal');
  eq(doc.getElementById('term-modal') !== null, true, 'el nodo de index.html NO se borra');
  eq(primary.listenerCount('pointerdown'), 0, 'pero queda sin listeners');
  eq(sockets.filter((s) => !s.closed).length, 0, 'y sin sockets vivos: nada quedó colgando');
  const renacida = terminalModule.open();
  await sleep(60);
  eq(renacida.id, 'term-modal', 'y se puede volver a abrir sobre el mismo nodo');
  eq(sockets.filter((s) => !s.closed).length, 1, 'con un PTY nuevo');
}

console.log(`\n${fallos === 0 ? 'VERDE' : 'ROJO'} — ${corridas - fallos}/${corridas} aserciones`);
process.exit(fallos === 0 ? 0 : 1);
