// Suite de la pestaña "Broker" del cortex-widget WEB (static/js/cortexWidget.js).
//
// Qué garantiza, y por qué NO se puede comprobar de otra forma: la pestaña muestra el estado de un
// servicio del HOST que ejecuta comandos: hay dos invariantes que, de romperse, no dan error visible
// sino una fuga o una promesa falsa —
//   (1) el TOKEN del broker jamás llega al HTML (el helper no lo emite; esto verifica que la pestaña
//       tampoco lo reconstruya ni lo pinte por accidente), y
//   (2) la pestaña DICE que es de solo lectura y marca con candado los knobs `gui=lee` — si el aviso
//       desaparece, la página promete una edición que el endpoint de axon no implementa (solo `list`).
// El resto verifica que los 12 knobs del spec de cortex se rendericen agrupados como en el QML.
//
// El fixture (tests/broker_tab_fixture.json) es la salida REAL de broker-scan.sh/broker-knobs.sh,
// anonimizada. Cuando los helpers de cortex existen en la máquina, el último test los corre en vivo y
// compara la FORMA contra el fixture — así el fixture no puede quedarse viejo en silencio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// ── DOM mínimo ────────────────────────────────────────────────────────────────────────────────────
// Los módulos HERMANOS que el widget importa (modalSnap, windowDrag) tocan el DOM al CARGARSE, así que
// el stub responde a cualquier propiedad con un nodo-Proxy. El widget mismo no se ejerce: se llama solo
// su función de render, con el estado inyectado a mano.
function nodo() {
  const base = { style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
                 dataset: {}, children: [], childNodes: [], value: '', textContent: '', innerHTML: '' };
  return new Proxy(base, {
    get(t, k) { if (k in t) return t[k]; if (typeof k === 'symbol') return undefined; return () => nodo(); },
    set(t, k, v) { t[k] = v; return true; },
  });
}
globalThis.document = new Proxy({
  readyState: 'loading',        // 'loading' evita que init() corra al importar el módulo
  hidden: false,
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, createElement: () => nodo(),
  body: nodo(), documentElement: nodo(), head: nodo(),
}, { get: (t, k) => (k in t ? t[k] : (typeof k === 'symbol' ? undefined : () => nodo())) });
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = (fn) => { void fn; return 0; };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.fetch = async () => { throw new Error('esta suite no debe tocar la red'); };

// ── Carga instrumentada del módulo ────────────────────────────────────────────────────────────────
// `BROKER_TAB_CONTROL=<n>` MUTA el módulo a propósito para comprobar que la suite DISCRIMINA (un test
// que sigue verde con el código roto no prueba nada). Cada control apaga UNA garantía; con él puesto,
// la suite DEBE fallar. Los tres se corrieron al escribirla y los tres se pusieron rojos.
const MUTACIONES = {
  1: ["k.gui === 'lee' ?", 'false ?'],                       // se cae el candado de los knobs de solo lectura
  2: ['Vista de SOLO LECTURA', 'Vista'],                     // se cae el aviso de solo lectura
  3: ['`${fmtInt(tk.chars)} chars`', 'String(tk.chars)'],    // el token deja de reportarse por longitud
};

function cargarWidget() {
  let src = readFileSync('static/js/cortexWidget.js', 'utf8').replace(
    'export default { open, close, toggle };',
    'export { renderBrokerTab, knobRowHtml, _broker, _brokerKnobs, ENDPOINTS };',
  );
  const ctrl = Number(process.env.BROKER_TAB_CONTROL || 0);
  if (ctrl) {
    const m = MUTACIONES[ctrl];
    assert.ok(m, `control desconocido: ${ctrl}`);
    assert.ok(src.includes(m[0]), `el control ${ctrl} ya no aplica: el ancla ${m[0]} cambió`);
    src = src.replace(m[0], m[1]);
  }
  // El módulo importa hermanos por ruta RELATIVA, así que la copia instrumentada vive en su MISMO
  // directorio y se borra en cuanto se cargó.
  const f = join('static/js', `.broker-tab-test-${process.pid}.mjs`);
  writeFileSync(f, src);
  try { return import('file://' + join(process.cwd(), f)); } finally { rmSync(f, { force: true }); }
}

const FIX = JSON.parse(readFileSync('tests/broker_tab_fixture.json', 'utf8'));
const W = await cargarWidget();

function conDatos() {
  W._broker.status = 'ok'; W._broker.data = FIX.scan; W._broker.message = '';
  W._brokerKnobs.status = 'ok'; W._brokerKnobs.data = FIX.knobs; W._brokerKnobs.message = '';
  return W.renderBrokerTab();
}

test('sin datos todavía muestra estado de carga, no un panel vacío', () => {
  W._broker.status = 'idle'; W._broker.data = null;
  assert.match(W.renderBrokerTab(), /ESCANEANDO/);
});

test('un fallo del helper NOMBRA el motivo en vez de callar', () => {
  W._broker.status = 'degraded'; W._broker.data = null;
  W._broker.message = 'los helpers del broker (broker-scan.sh / broker-knobs.sh) no están en este host';
  const html = W.renderBrokerTab();
  assert.match(html, /SIN DATOS/);
  assert.match(html, /broker-scan\.sh/);
});

test('la pestaña AVISA que es de solo lectura', () => {
  assert.ok(conDatos().includes('Vista de SOLO LECTURA'));
});

test('muestra servicio, puerto y socket reales', () => {
  const html = conDatos();
  assert.ok(html.includes(FIX.scan.unidad.estado));
  assert.ok(html.includes(String(FIX.scan.endpoint.puerto)));
  assert.ok(html.includes(FIX.scan.endpoint.socket));
});

test('el token se reporta por PRESENCIA y longitud, nunca por su valor', () => {
  const html = conDatos();
  assert.ok(html.includes(`${FIX.scan.token.chars} chars`));
  // Nada con pinta de secreto: ninguna corrida larga de hex en el HTML.
  assert.equal(/[A-Fa-f0-9]{32,}/.test(html), false);
});

test('los 12 knobs del spec salen todos, y los gui=lee con candado', () => {
  const html = conDatos();
  const knobs = FIX.knobs.knobs;
  assert.equal(knobs.length, 12);
  for (const k of knobs) assert.ok(html.includes(k.env), `falta el knob ${k.env}`);
  const candados = (html.match(/cortex-knob-lock/g) || []).length;
  assert.equal(candados, knobs.filter((k) => k.gui === 'lee').length);
});

test('los grupos se rotulan en el mismo orden que el QML de cortex', () => {
  const html = conDatos();
  const titulos = ['Endpoint y contrato con el cliente', 'Topes de concurrencia',
                   'WebSocket: contrapresión y keepalive', 'Topes del HTTP', 'Proceso'];
  let pos = -1;
  for (const t of titulos) {
    const i = html.indexOf(t);
    assert.ok(i > pos, `el grupo "${t}" falta o está fuera de orden`);
    pos = i;
  }
});

test('la advertencia de un knob peligroso se muestra junto a él', () => {
  assert.ok(conDatos().includes('no es una sandbox'));   // AXON_TERM_BROKER_BIND fuera de loopback
});

test('un knob sin valor en el .env se marca default; con valor, .env', () => {
  const base = { env: 'X', etiqueta: 'X', grupo: 'proceso', default: '7' };
  assert.ok(W.knobRowHtml({ ...base, actual: null, gui: 'lee' }).includes('>default<'));
  assert.ok(W.knobRowHtml({ ...base, actual: '9', gui: 'edita' }).includes('>.env<'));
});

test('el endpoint que consume es de solo lectura (list), nunca set/unset', () => {
  assert.equal(W.ENDPOINTS.broker, '/api/cortex/broker?knobs=1');
  const src = readFileSync('static/js/cortexWidget.js', 'utf8');
  assert.equal(/broker-knobs\.sh['"\s+]*(set|unset)/.test(src), false);
});

// El fixture no puede quedarse viejo en silencio: donde los helpers de cortex existen (la máquina del
// dueño), se corren de verdad y se compara la FORMA — no los valores, que sí cambian por máquina.
const HELPERS = join(process.env.HOME || '', 'code/cortex/src/plasmoid/contents');
test('el fixture sigue teniendo la forma que emiten los helpers reales', { skip: !existsSync(join(HELPERS, 'broker-scan.sh')) }, () => {
  const scan = JSON.parse(execFileSync('bash', [join(HELPERS, 'broker-scan.sh'), 'scan'], { encoding: 'utf8' }));
  const knobs = JSON.parse(execFileSync('bash', [join(HELPERS, 'broker-knobs.sh'), 'list'], { encoding: 'utf8' }));
  assert.deepEqual(Object.keys(scan).sort(), Object.keys(FIX.scan).sort());
  assert.deepEqual(Object.keys(scan.endpoint).sort(), Object.keys(FIX.scan.endpoint).sort());
  assert.deepEqual(Object.keys(scan.unidad).sort(), Object.keys(FIX.scan.unidad).sort());
  assert.deepEqual(knobs.knobs.map((k) => k.env).sort(), FIX.knobs.knobs.map((k) => k.env).sort());
  assert.deepEqual(Object.keys(knobs.knobs[0]).sort(), Object.keys(FIX.knobs.knobs[0]).sort());
});
